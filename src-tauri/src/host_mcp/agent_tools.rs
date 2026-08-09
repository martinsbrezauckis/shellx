use super::*;

// ───── Agent family wrappers ─────
//
// Thin shims that pull args out of the MCP `arguments` Value and forward
// to crate::subagent. The validation lives there; here we just adapt
// the JSON envelope. Keeping these in host_mcp.rs so all MCP tool entry
// points are reviewable in one file.

/// `Agent` — spawn a subagent with a persona. See crate::subagent::spawn_subagent.
pub(super) async fn tool_agent_spawn(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    if nested_agent_spawn_blocked_by_env() {
        return Err(
            "Agent: nested Agent dispatch is disabled inside shellX subagents. Return your own findings instead of spawning another Agent."
                .to_string(),
        );
    }

    let persona = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .ok_or("Agent: missing 'subagent_type'")?
        .to_string();
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .ok_or("Agent: missing 'task'")?
        .to_string();
    // AGENT-B3 — resolve the parent tab's transport so the subagent grok
    // spawns inside the right runtime. Without this, a WSL parent's
    // Agent subagent always lands on the Windows host (`uname -a` returns
    // MINGW64_NT, not Linux) and can't reach files on the WSL side.
    // Falls back to local when:
    // - no tab_id (stdio MCP path with no SHELLX_HOST_MCP_TAB_ID env)
    // - registry lookup misses (tab closed between call and resolve)
    // - app_handle missing (standalone test mode)
    let parent_transport: crate::subagent::SubagentTransport =
        resolve_parent_transport_for_subagent(ctx, tab_id).await;
    let parent_is_wsl = matches!(
        &parent_transport,
        crate::subagent::SubagentTransport::Wsl { .. }
    );
    // cwd default: the host MCP context's cwd (= the parent grok session's
    // working dir when spawned through grok's MCP auto-discovery).
    // // A WSL-session caller may pass a POSIX path like
    // `/home/me/proj`. The subagent process runs on the Windows host
    // (host-MCP spawns it via shellX's binary), so a POSIX cwd is
    // invalid → ERROR_DIRECTORY at spawn. Apply the same
    // `\\wsl$\<distro>\…` UNC translation we use for fs/* paths — but
    // only when we can discover the distro. Without a distro, return
    // a helpful error instead of letting Windows fail spawn with an
    // opaque OS error.
    let raw_cwd = crate::acp::sanitize_cwd_param(args.get("cwd").and_then(|v| v.as_str()))
        .map_err(|e| format!("Agent: invalid cwd: {}", e))?;
    let default_cwd = resolve_default_agent_cwd(ctx, tab_id).await;
    let cwd = match raw_cwd {
        Some(p) if p.starts_with('/') && !p.starts_with("/mnt/") => {
            // WSL subagents are spawned through `wsl.exe --cd`, which
            // expects the Linux path. Only translate POSIX paths to UNC
            // when the subagent will actually run as a Local Windows
            // process.
            if parent_is_wsl {
                Some(p)
            } else if cfg!(target_os = "windows") {
                let distros = wsl_running_distros().await;
                match distros.first() {
                    Some(distro) => {
                        let rest = p.trim_start_matches('/').replace('/', "\\");
                        Some(format!("\\\\wsl$\\{}\\{}", distro, rest))
                    }
                    None => {
                        return Err(format!(
                            "Agent: cwd '{}' is a POSIX path but no running WSL distro \
                             was detected. Pass a Windows-form path (e.g. C:\\Users\\you\\proj) \
                             or run from a WSL preset so shellX can map it through \\\\wsl$\\<distro>\\…",
                            p
                        ));
                    }
                }
            } else {
                Some(p)
            }
        }
        Some(p) => Some(p),
        None => default_cwd,
    };
    let wait = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);
    let effective_cwd = cwd.clone();
    // Optional ledger_dir — when set, spawn_subagent writes
    // `<ledger_dir>/<subagent_id>.md` atomically after the child is
    // running, so the parent build manager never has to. Validate the
    // path against the same rules as fs_write (absolute, no '..', no
    // null byte) — otherwise a misconfigured caller could try to write
    // under `/etc/` or smuggle a traversal.
    let ledger_dir = match args.get("ledger_dir").and_then(|v| v.as_str()) {
        Some(s) => match &parent_transport {
            crate::subagent::SubagentTransport::Wsl { distro, .. }
                if s.starts_with('/') && !s.starts_with("/mnt/") =>
            {
                let rest = s.trim_start_matches('/').replace('/', "\\");
                let unc = format!("\\\\wsl$\\{}\\{}", distro, rest);
                Some(validate_fs_path("Agent.ledger_dir", &unc)?)
            }
            crate::subagent::SubagentTransport::Ssh { .. }
                if s.starts_with('/') && !s.starts_with("/mnt/") =>
            {
                // The subagent itself now runs on the SSH target, but
                // ledger files are still written by the shellX host
                // process. A POSIX SSH path would be rejected by the host
                // fs guard or land on the wrong machine, so skip only the
                // optional ledger while preserving the actual Agent spawn.
                None
            }
            _ => Some(validate_fs_path("Agent.ledger_dir", s)?),
        },
        None => None,
    };
    // Timing policy is intentionally split:
    // - wait_budget_ms controls this MCP call's wait.
    // - max_runtime_ms is the only hard kill budget.
    // - timeout_ms remains as a legacy alias.
    let timeout_ms = parse_agent_duration_ms(&args, "timeout_ms", MAX_AGENT_HARD_RUNTIME_MS);
    let wait_budget_ms = parse_agent_duration_ms(&args, "wait_budget_ms", MAX_AGENT_WAIT_BUDGET_MS)
        .or(timeout_ms)
        .unwrap_or(crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS);
    let max_runtime_ms =
        parse_agent_duration_ms(&args, "max_runtime_ms", MAX_AGENT_HARD_RUNTIME_MS);
    let active_build = active_build_run_for_mcp(ctx, tab_id, "Agent")
        .await
        .map(|(_, _, state)| state.status == crate::build_types::BuildRunStatus::Active)
        .unwrap_or(false);
    let task = if active_build {
        build_gate_agent_task(&persona, &task)
    } else {
        task
    };
    if wait {
        let receipt_meta = BuildAgentReceiptMeta {
            wait: Some(wait),
            wait_budget_ms: Some(wait_budget_ms),
            max_runtime_ms,
        };
        let running = {
            let _guard = build_agent_start_lock().lock().await;
            if let Some(message) =
                build_agent_spawn_rejected_by_build_gate(ctx, tab_id, &persona, wait).await
            {
                return Ok(agent_tool_error_response(message));
            }
            let timing = match max_runtime_ms {
                Some(ms) => crate::subagent::AgentTimingOptions::build_wait(Some(wait_budget_ms))
                    .with_hard_runtime(ms),
                None => crate::subagent::AgentTimingOptions::build_wait(Some(wait_budget_ms)),
            };
            let running = crate::subagent::spawn_subagent_with_transport_options(
                &persona,
                &task,
                cwd,
                false,
                ledger_dir,
                timing,
                parent_transport,
            )
            .await?;
            stamp_agent_subagent_tab(&running, tab_id).await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Started(Some(&running)),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
            running
        };

        let Some(subagent_id) = running.get("subagent_id").and_then(|v| v.as_str()) else {
            return Ok(running);
        };
        let result = match tokio::time::timeout(
            Duration::from_millis(wait_budget_ms),
            crate::subagent::output(subagent_id, true),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                let partial = crate::subagent::output(subagent_id, false).await.ok();
                Ok(build_agent_wait_budget_result(
                    subagent_id,
                    &persona,
                    partial,
                    wait_budget_ms,
                ))
            }
        };
        if let Ok(value) = &result {
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Completed(value),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
        }
        return result;
    }

    {
        let _guard = build_agent_start_lock().lock().await;
        if let Some(message) =
            build_agent_spawn_rejected_by_build_gate(ctx, tab_id, &persona, wait).await
        {
            return Ok(agent_tool_error_response(message));
        }
        let receipt_meta = BuildAgentReceiptMeta {
            wait: Some(wait),
            wait_budget_ms: None,
            max_runtime_ms,
        };
        let timing = build_async_agent_timing(active_build, timeout_ms, max_runtime_ms);
        let result = crate::subagent::spawn_subagent_with_transport_options(
            &persona,
            &task,
            cwd,
            false,
            ledger_dir,
            timing,
            parent_transport,
        )
        .await;

        if let Ok(value) = &result {
            stamp_agent_subagent_tab(value, tab_id).await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Started(Some(value)),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Completed(value),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
        }

        result
    }
}

pub(super) async fn stamp_agent_subagent_tab(value: &Value, tab_id: Option<&str>) {
    let Some(tab) = tab_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    let Some(subagent_id) = value.get("subagent_id").and_then(|v| v.as_str()) else {
        return;
    };
    if let Err(e) = crate::subagent::set_tab_id(subagent_id, tab).await {
        tracing::warn!(
            "Agent: failed to stamp subagent {} with tab {}: {}",
            subagent_id,
            tab,
            e
        );
    }
}

pub(super) fn build_async_agent_timing(
    _active_build: bool,
    timeout_ms: Option<u64>,
    max_runtime_ms: Option<u64>,
) -> crate::subagent::AgentTimingOptions {
    if let Some(ms) = max_runtime_ms {
        crate::subagent::AgentTimingOptions {
            wait_budget_ms: None,
            watchdog: crate::subagent::SubagentWatchdogPolicy::Hard { max_runtime_ms: ms },
        }
    } else {
        crate::subagent::AgentTimingOptions::detached_default(timeout_ms)
    }
}

pub(super) fn build_agent_wait_budget_result(
    subagent_id: &str,
    persona: &str,
    partial: Option<Value>,
    wait_budget_ms: u64,
) -> Value {
    let stdout = partial
        .as_ref()
        .and_then(|v| v.get("stdout"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let stderr_tail = partial
        .as_ref()
        .and_then(|v| v.get("stderr_tail"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let task_preview = partial
        .as_ref()
        .and_then(|v| v.get("task_preview"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let elapsed_ms = partial
        .as_ref()
        .and_then(|v| v.get("elapsed_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(wait_budget_ms);
    let total_tokens = partial
        .as_ref()
        .and_then(|v| v.get("total_tokens"))
        .cloned()
        .unwrap_or(Value::Null);

    json!({
        "subagent_id": subagent_id,
        "persona": persona,
        "status": "running",
        "exit_code": Value::Null,
        "elapsed_ms": elapsed_ms,
        "total_tokens": total_tokens,
        "stdout": stdout,
        "stderr_tail": if stderr_tail.is_empty() {
            format!("Agent wait budget expired after {} ms; the subagent is still running. Poll Agent_status or Agent_output.", wait_budget_ms)
        } else {
            format!("{}\n\nAgent wait budget expired after {} ms; the subagent is still running. Poll Agent_status or Agent_output.", stderr_tail, wait_budget_ms)
        },
        "task_preview": task_preview,
        "timed_out": false,
        "wait_budget_expired": true,
        "wait_budget_ms": wait_budget_ms,
        "timeout_ms": wait_budget_ms,
    })
}

pub(super) fn nested_agent_spawn_blocked_by_env() -> bool {
    if env_flag_enabled("SHELLX_ALLOW_NESTED_AGENTS") {
        return false;
    }
    std::env::var("SHELLX_SUBAGENT_DEPTH")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0)
        > 0
}

pub(super) fn env_flag_enabled(key: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(super) fn choose_agent_cwd(
    explicit_cwd: Option<String>,
    active_build_cwd: Option<String>,
    tab_session_cwd: Option<String>,
    process_cwd: Option<String>,
) -> Option<String> {
    let default_cwd = active_build_cwd
        .filter(|s| !s.trim().is_empty())
        .or_else(|| tab_session_cwd.filter(|s| !s.trim().is_empty()))
        .or_else(|| process_cwd.filter(|s| !s.trim().is_empty()));
    resolve_agent_cwd(explicit_cwd, default_cwd)
}

pub(super) fn resolve_agent_cwd(
    explicit_cwd: Option<String>,
    default_cwd: Option<String>,
) -> Option<String> {
    let explicit = explicit_cwd
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    match explicit {
        Some(cwd) if agent_cwd_is_absolute_like(&cwd) => Some(cwd),
        Some(cwd) => match default_cwd {
            Some(base) if !base.trim().is_empty() => Some(join_agent_relative_cwd(&base, &cwd)),
            _ => Some(cwd),
        },
        None => default_cwd,
    }
}

pub(super) fn agent_cwd_is_absolute_like(cwd: &str) -> bool {
    let cwd = cwd.trim();
    if cwd.starts_with('/') || cwd.starts_with("\\\\") || cwd.starts_with("//") {
        return true;
    }
    let bytes = cwd.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

pub(super) fn join_agent_relative_cwd(base: &str, relative: &str) -> String {
    let base = base.trim();
    let mut rel = relative.trim();
    while rel == "." || rel.starts_with("./") || rel.starts_with(".\\") {
        if rel == "." {
            return base.to_string();
        }
        rel = &rel[2..];
    }
    if rel.is_empty() {
        return base.to_string();
    }

    let windows_like_base = agent_cwd_is_windows_like(base);
    let separator = if windows_like_base { "\\" } else { "/" };
    let base_trimmed = base.trim_end_matches(['\\', '/']);
    let rel_normalized = if windows_like_base {
        rel.replace('/', "\\")
    } else {
        rel.replace('\\', "/")
    };
    format!(
        "{}{}{}",
        base_trimmed,
        separator,
        rel_normalized.trim_start_matches(['\\', '/'])
    )
}

pub(super) fn agent_cwd_is_windows_like(cwd: &str) -> bool {
    let cwd = cwd.trim();
    cwd.starts_with("\\\\")
        || cwd.starts_with("//")
        || (cwd.len() >= 3
            && cwd.as_bytes()[0].is_ascii_alphabetic()
            && cwd.as_bytes()[1] == b':'
            && matches!(cwd.as_bytes()[2], b'\\' | b'/'))
}

pub(super) fn build_state_supplies_agent_cwd(state: &crate::build_types::BuildRunState) -> bool {
    !build_status_is_terminal(&state.status)
}

pub(super) fn build_status_is_terminal(status: &crate::build_types::BuildRunStatus) -> bool {
    use crate::build_types::BuildRunStatus;
    matches!(
        status,
        BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
    )
}

pub(super) fn build_terminal_state_suppresses_agent(
    state: &crate::build_types::BuildRunState,
    now_ms: u64,
) -> bool {
    build_status_is_terminal(&state.status)
        && now_ms.saturating_sub(state.updated_at_ms) <= BUILD_TERMINAL_AGENT_SUPPRESSION_MS
}

pub(super) async fn resolve_default_agent_cwd(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Option<String> {
    let tab_id = tab_id
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.trim().is_empty());
    let process_cwd = ctx.cwd.to_str().map(|s| s.to_string());
    let Some(app) = ctx.app_handle.as_ref() else {
        return choose_agent_cwd(None, None, None, process_cwd);
    };
    let Some(tab) = tab_id.as_deref() else {
        return choose_agent_cwd(None, None, None, process_cwd);
    };

    use tauri::Manager as _;

    let active_build_cwd = if let Some(orch_state) =
        app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    {
        orch_state
            .inner()
            .clone()
            .get_state(tab)
            .await
            .filter(build_state_supplies_agent_cwd)
            .map(|state| state.cwd)
    } else {
        None
    };

    let tab_session_cwd =
        if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
            if let Some(arc) = registry.get_existing(tab).await {
                let guard = arc.lock().await;
                let info = guard.get_debug_session_info();
                drop(guard);
                info.get("cwd").and_then(|v| v.as_str()).map(str::to_string)
            } else {
                None
            }
        } else {
            None
        };

    choose_agent_cwd(None, active_build_cwd, tab_session_cwd, process_cwd)
}

/// AGENT-B3 helper: pull the parent tab's transport from the
/// SessionRegistry so subagent spawn lands in the right runtime. Falls
/// back to Local in the absence of a tab id (stdio mode without
/// SHELLX_HOST_MCP_TAB_ID, standalone tests, fresh boot before any
/// /connect).
pub(super) async fn resolve_parent_transport_for_subagent(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> crate::subagent::SubagentTransport {
    use crate::subagent::SubagentTransport;
    // Resolve a usable tab id from either the explicit caller-supplied
    // value or the SHELLX_HOST_MCP_TAB_ID env that shellX seeds when
    // spawning the host MCP child for a specific tab.
    let resolved_tab: Option<String> = tab_id
        .map(|s| s.to_string())
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.is_empty());
    let Some(tab) = resolved_tab else {
        return SubagentTransport::Local {
            tab_id: "default".to_string(),
        };
    };
    let Some(app) = ctx.app_handle.as_ref() else {
        return SubagentTransport::Local { tab_id: tab };
    };
    use tauri::Manager as _;
    let Some(reg) = app.try_state::<Arc<crate::acp::SessionRegistry>>() else {
        return SubagentTransport::Local { tab_id: tab };
    };
    let Some(sess_arc) = reg.inner().clone().get_existing(&tab).await else {
        return SubagentTransport::Local { tab_id: tab };
    };
    let guard = sess_arc.lock().await;
    let info = guard.get_debug_session_info();
    let configured_wsl_grok_path = guard.wsl_grok_path().map(str::to_string);
    let configured_ssh = guard.ssh_config().cloned();
    drop(guard);
    if let Some(ssh) = configured_ssh {
        return SubagentTransport::Ssh {
            host: ssh.host,
            port: ssh.port,
            key_vault_ref: ssh.key_vault_ref,
            remote_grok_path: ssh.remote_grok_path,
            remote_runtime: ssh.remote_runtime,
            wsl_distro: ssh.wsl_distro,
            tab_id: tab,
        };
    }
    let wsl_distro = info
        .get("wslDistro")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    match wsl_distro {
        Some(distro) => SubagentTransport::Wsl {
            distro,
            grok_path: configured_wsl_grok_path,
            tab_id: tab,
        },
        None => SubagentTransport::Local { tab_id: tab },
    }
}

/// `Agent_status` — poll status without consuming output.
pub(super) async fn tool_agent_status(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_status: missing 'subagent_id'")?;
    let value = crate::subagent::status(id).await?;
    record_build_agent_completion_from_poll(&value, ctx, tab_id, "Agent_status").await;
    Ok(value)
}

/// `Agent_output` — fetch the final stdout (optionally waiting).
pub(super) async fn tool_agent_output(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_output: missing 'subagent_id'")?
        .to_string();
    let wait_for_complete = args
        .get("wait_for_complete")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let active_build = active_build_run_for_mcp(ctx, tab_id, "Agent_output")
        .await
        .map(|(_, _, state)| state.status == crate::build_types::BuildRunStatus::Active)
        .unwrap_or(false);
    let effective_wait = effective_agent_output_wait_for_complete(wait_for_complete, active_build);
    let mut value = crate::subagent::output(&id, effective_wait).await?;
    if wait_for_complete && !effective_wait {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("wait_for_complete_deferred".into(), Value::Bool(true));
            obj.insert(
                "note".into(),
                Value::String(
                    "Build Mode does not block Agent_output while a subagent is still running; poll Agent_status or Agent_output again."
                        .into(),
                ),
            );
        }
    }
    record_build_agent_completion_from_poll(&value, ctx, tab_id, "Agent_output").await;
    Ok(value)
}

pub(super) fn effective_agent_output_wait_for_complete(
    requested: bool,
    active_build: bool,
) -> bool {
    requested && !active_build
}

/// `Agent_poll_all` — non-blocking batch status. Returns
/// `{snapshots: [<status-shape> ...], at_unix_ms}`. Per-id errors
/// are returned inline as `{subagent_id, error: <msg>}` so a single
/// bad id doesn't fail the whole batch. Replaces the
/// "issue 15 sequential Agent_status calls" pattern.
pub(super) const MAX_AGENT_POLL_ALL_IDS: usize = 64;

pub(super) fn agent_poll_all_ids(args: &Value) -> Result<Vec<String>, String> {
    let values = args
        .get("subagent_ids")
        .and_then(Value::as_array)
        .ok_or("Agent_poll_all: missing 'subagent_ids' (array of UUIDs)")?;
    if values.is_empty() {
        return Err("Agent_poll_all: 'subagent_ids' is empty".to_string());
    }
    if values.len() > MAX_AGENT_POLL_ALL_IDS {
        return Err(format!(
            "Agent_poll_all: 'subagent_ids' supports at most {MAX_AGENT_POLL_ALL_IDS} entries"
        ));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let id = value
                .as_str()
                .ok_or_else(|| format!("Agent_poll_all: subagent_ids[{index}] must be a string"))?;
            let id = id.trim();
            if id.is_empty() {
                return Err(format!(
                    "Agent_poll_all: subagent_ids[{index}] must not be empty"
                ));
            }
            if id.len() > 200 {
                return Err(format!(
                    "Agent_poll_all: subagent_ids[{index}] exceeds 200 bytes"
                ));
            }
            Ok(id.to_string())
        })
        .collect()
}

pub(super) async fn tool_agent_poll_all(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let ids = agent_poll_all_ids(&args)?;
    let mut snapshots: Vec<Value> = Vec::with_capacity(ids.len());
    for id in &ids {
        match crate::subagent::status(id).await {
            Ok(v) => {
                record_build_agent_completion_from_poll(&v, ctx, tab_id, "Agent_poll_all").await;
                snapshots.push(v)
            }
            Err(msg) => snapshots.push(json!({
                "subagent_id": id,
                "error": msg,
            })),
        }
    }
    Ok(json!({
        "snapshots": snapshots,
        "at_unix_ms": now_ms(),
    }))
}
