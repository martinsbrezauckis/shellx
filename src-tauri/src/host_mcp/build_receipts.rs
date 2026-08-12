use super::*;

pub(super) enum BuildAgentReceiptEvent<'a> {
    Started(Option<&'a Value>),
    Completed(&'a Value),
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct BuildAgentReceiptMeta {
    pub(super) wait: Option<bool>,
    pub(super) wait_budget_ms: Option<u64>,
    pub(super) max_runtime_ms: Option<u64>,
}

pub(super) fn insert_build_agent_receipt_timing(
    map: &mut serde_json::Map<String, Value>,
    meta: BuildAgentReceiptMeta,
    value: Option<&Value>,
) {
    if let Some(wait) = meta.wait {
        map.insert("wait".into(), Value::Bool(wait));
    } else {
        map.insert("wait".into(), Value::Null);
    }
    if let Some(ms) = meta.wait_budget_ms {
        map.insert(
            "waitBudgetMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    }
    if let Some(ms) = meta.max_runtime_ms {
        map.insert(
            "maxRuntimeMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    }

    let value_watchdog_policy = value
        .and_then(|v| v.get("watchdog_policy"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let watchdog_policy = value_watchdog_policy.or_else(|| {
        if meta.max_runtime_ms.is_some() {
            Some("hard".to_string())
        } else if meta.wait_budget_ms.is_some() {
            Some("disabled".to_string())
        } else {
            None
        }
    });
    if let Some(policy) = watchdog_policy {
        map.insert("watchdogPolicy".into(), Value::String(policy));
    }

    let value_watchdog_ms = value
        .and_then(|v| v.get("watchdog_ms"))
        .and_then(|v| v.as_u64());
    let watchdog_ms = value_watchdog_ms.or(meta.max_runtime_ms);
    if let Some(ms) = watchdog_ms {
        map.insert(
            "watchdogMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    } else if watchdog_policy_is_disabled(map) {
        map.insert("watchdogMs".into(), Value::Null);
    }
}

pub(super) fn watchdog_policy_is_disabled(map: &serde_json::Map<String, Value>) -> bool {
    map.get("watchdogPolicy").and_then(|v| v.as_str()) == Some("disabled")
}

pub(super) struct BuildHostReceipt<'a> {
    pub(super) kind: crate::build_types::BuildReceiptKind,
    pub(super) actor: &'a str,
    pub(super) summary: String,
    pub(super) confidence: crate::build_types::BuildReceiptConfidence,
    pub(super) data: Value,
}

pub(super) async fn active_build_run_for_mcp(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Option<(
    Arc<crate::build_orchestrator::BuildOrchestrator>,
    String,
    crate::build_types::BuildRunState,
)> {
    use tauri::Manager as _;

    let tab = resolve_mcp_tab_id(tab_id, tool_name).ok()?;
    let app_handle = ctx.app_handle.as_ref()?;
    let orch_state = app_handle.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()?;
    let orch = orch_state.inner().clone();
    let state = orch.get_state(&tab).await?;
    Some((orch, tab, state))
}

pub(super) async fn build_agent_receipt_key_for_current_run(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
    subagent_id: &str,
) -> Option<String> {
    if subagent_id.is_empty() {
        return None;
    }
    active_build_run_for_mcp(ctx, tab_id, tool_name)
        .await
        .map(|(_, _, state)| build_agent_watcher_key(&state.run_id, subagent_id))
}

pub(super) async fn build_agent_spawn_rejected_by_build_gate(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    persona: &str,
    wait: bool,
) -> Option<String> {
    if let Some((orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await {
        if build_terminal_state_suppresses_agent(&state, now_millis_for_build_receipt()) {
            return Some(format!(
                "Agent: /build tab {} is already {:?}; do not start more subagents after build_complete. Stop and report the accepted build summary instead.",
                tab, state.status
            ));
        }
        if !wait {
            return None;
        }
        if !build_status_allows_in_flight_agent_guard(&state.status) {
            return None;
        }
        let in_flight = orch.in_flight_agent_summaries(&tab).await.ok()?;
        return build_agent_in_flight_rejection(&tab, persona, in_flight);
    }

    build_agent_spawn_rejected_by_debug_api_build_gate(tab_id, persona, wait).await
}

pub(super) async fn build_agent_spawn_rejected_by_debug_api_build_gate(
    tab_id: Option<&str>,
    persona: &str,
    wait: bool,
) -> Option<String> {
    let tab = resolve_mcp_tab_id(tab_id, "Agent").ok()?;
    let state_data = debug_api_get_json_optional_not_found(
        &format!("/build/state?tabId={}", encode_query_component(&tab)),
        5,
    )
    .await
    .ok()??;
    let state = state_data.get("state")?;
    let status = state.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let updated_at_ms = state
        .get("updatedAtMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if build_status_string_suppresses_agent(status, updated_at_ms, now_millis_for_build_receipt()) {
        return Some(format!(
            "Agent: /build tab {} is already {}; do not start more subagents after build_complete. Stop and report the accepted build summary instead.",
            tab, status
        ));
    }
    if !wait || !build_status_string_allows_in_flight_agent_guard(status) {
        return None;
    }
    let receipts_data = debug_api_get_json_optional_not_found(
        &format!("/build/receipts?tabId={}", encode_query_component(&tab)),
        5,
    )
    .await
    .ok()??;
    let receipts = receipts_data
        .get("receipts")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    build_agent_in_flight_rejection(
        &tab,
        persona,
        build_in_flight_agent_summaries_from_receipt_values(receipts),
    )
}

pub(super) fn build_agent_in_flight_rejection(
    tab: &str,
    persona: &str,
    in_flight: Vec<String>,
) -> Option<String> {
    if in_flight.is_empty() {
        None
    } else {
        Some(format!(
            "Agent: /build tab {} already has in-flight Agent(s): {}. Do not start another wait=true `{}` Agent until the running Agent completes; use Agent_status/Agent_output if you need to poll it.",
            tab,
            in_flight.join(", "),
            persona
        ))
    }
}

pub(super) fn build_status_string_suppresses_agent(
    status: &str,
    updated_at_ms: u64,
    now_ms: u64,
) -> bool {
    matches!(status, "complete" | "halted" | "transportFailed")
        && now_ms.saturating_sub(updated_at_ms) <= BUILD_TERMINAL_AGENT_SUPPRESSION_MS
}

pub(super) fn build_status_allows_in_flight_agent_guard(
    status: &crate::build_types::BuildRunStatus,
) -> bool {
    !matches!(
        status,
        crate::build_types::BuildRunStatus::Complete
            | crate::build_types::BuildRunStatus::Halted
            | crate::build_types::BuildRunStatus::TransportFailed
    )
}

pub(super) fn build_status_string_allows_in_flight_agent_guard(status: &str) -> bool {
    matches!(
        status,
        "draft" | "awaitingApproval" | "active" | "paused" | "blocked" | "budgetLimited"
    )
}

pub(super) fn build_in_flight_agent_summaries_from_receipt_values(
    receipts: &[Value],
) -> Vec<String> {
    let mut started: Vec<(Option<String>, String)> = Vec::new();
    for receipt in receipts {
        match receipt.get("kind").and_then(|v| v.as_str()) {
            Some("agentStarted") => {
                started.push((
                    build_receipt_value_agent_id(receipt).map(ToOwned::to_owned),
                    build_receipt_value_agent_summary(receipt),
                ));
            }
            Some("agentCompleted") => {
                if receipt
                    .get("data")
                    .and_then(|v| v.get("status"))
                    .and_then(|v| v.as_str())
                    == Some("running")
                {
                    continue;
                }
                if let Some(id) = build_receipt_value_agent_id(receipt) {
                    if let Some(pos) = started
                        .iter()
                        .position(|(started_id, _)| started_id.as_deref() == Some(id))
                    {
                        started.remove(pos);
                    }
                } else if let Some(pos) = started
                    .iter()
                    .position(|(started_id, _)| started_id.is_none())
                {
                    started.remove(pos);
                }
            }
            _ => {}
        }
    }
    started.into_iter().map(|(_, summary)| summary).collect()
}

pub(super) fn build_receipt_value_agent_id(receipt: &Value) -> Option<&str> {
    receipt
        .get("data")
        .and_then(|v| v.get("subagentId").or_else(|| v.get("subagent_id")))
        .and_then(|v| v.as_str())
}

pub(super) fn build_receipt_value_agent_summary(receipt: &Value) -> String {
    let data = receipt.get("data").unwrap_or(&Value::Null);
    let persona = data
        .get("persona")
        .and_then(|v| v.as_str())
        .unwrap_or("agent");
    let subagent_id = build_receipt_value_agent_id(receipt).unwrap_or("unknown");
    format!("{} {}", persona, subagent_id)
}

pub(super) fn agent_tool_error_response(message: String) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": message,
        }],
        "isError": true,
    })
}

pub(super) async fn append_build_host_receipt(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
    receipt: BuildHostReceipt<'_>,
) {
    use crate::build_types::{BuildReceiptKind, BuildRunStatus};
    let BuildHostReceipt {
        kind,
        actor,
        summary,
        confidence,
        data,
    } = receipt;

    let Some((orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, tool_name).await else {
        if let Ok(tab) = resolve_mcp_tab_id(tab_id, tool_name) {
            if let Err(e) =
                post_build_receipt_to_debug_api(&tab, kind, actor, summary, confidence, data).await
            {
                tracing::debug!(
                    "build receipt debug-api fallback failed for {}: {}",
                    tool_name,
                    e
                );
            }
        }
        return;
    };
    if matches!(
        state.status,
        BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
    ) {
        return;
    }
    let mut kind = kind;
    let mut summary = summary;
    let mut data = data;
    let path_for_receipt = data
        .get("path")
        .or_else(|| data.get("dst"))
        .and_then(|v| v.as_str());
    if let Some(path) = path_for_receipt {
        if build_receipt_path_matches(path, &state.scratchboard_path) {
            if kind == BuildReceiptKind::FileWrite {
                kind = BuildReceiptKind::PlanWritten;
                summary = format!("Build scratchboard written: {}", path);
                if let Value::Object(ref mut map) = data {
                    map.insert("scratchboard".into(), Value::Bool(true));
                }
            } else if matches!(
                kind,
                BuildReceiptKind::FileDelete | BuildReceiptKind::FileCopy
            ) {
                return;
            }
        }
    }
    if matches!(
        kind,
        BuildReceiptKind::AgentCompleted
            | BuildReceiptKind::ReviewCompleted
            | BuildReceiptKind::VerificationCompleted
    ) {
        if let Some(subagent_id) = data.get("subagentId").and_then(|v| v.as_str()) {
            if let Ok(receipts) = orch.get_receipts(&tab).await {
                if receipts.iter().any(|receipt| {
                    receipt.kind == kind
                        && receipt.data.get("subagentId").and_then(|v| v.as_str())
                            == Some(subagent_id)
                }) {
                    return;
                }
            }
        }
    }
    if let Err(e) = orch
        .append_receipt(crate::build_types::BuildReceipt {
            receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
            run_id: state.run_id,
            tab_id: tab,
            kind,
            created_at_ms: now_millis_for_build_receipt(),
            actor: actor.to_string(),
            summary,
            confidence,
            data,
        })
        .await
    {
        tracing::warn!("build receipt append failed for {}: {}", tool_name, e);
    }
}

pub(super) fn build_receipt_path_matches(a: &str, b: &str) -> bool {
    let normalize = |s: &str| {
        s.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    normalize(a) == normalize(b)
}

pub(super) async fn record_build_tool_receipt(
    tool_name: &str,
    args: &Value,
    result: &Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let mut receipt: Option<(BuildReceiptKind, String, Value)> = None;
    match tool_name {
        "fs_write" => {
            let path = result
                .get("path")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("path").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            let bytes = result
                .get("bytes_written")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            receipt = Some((
                BuildReceiptKind::FileWrite,
                format!("File written: {} ({} bytes)", path, bytes),
                json!({
                    "tool": tool_name,
                    "path": path,
                    "bytesWritten": bytes,
                    "encoding": result.get("encoding").and_then(|v| v.as_str()).unwrap_or("utf8"),
                    "createDirs": args.get("create_dirs").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }
        "fs_append" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("<unknown>");
            let bytes = result
                .get("bytes_appended")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            receipt = Some((
                BuildReceiptKind::FileWrite,
                format!("File appended: {} ({} bytes)", path, bytes),
                json!({
                    "tool": tool_name,
                    "path": path,
                    "bytesAppended": bytes,
                    "newSize": result.get("new_size").and_then(|v| v.as_u64()).unwrap_or(0),
                }),
            ));
        }
        "fs_copy" => {
            let src = result
                .get("src")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("src").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            let dst = result
                .get("dst")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("dst").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            receipt = Some((
                BuildReceiptKind::FileCopy,
                format!("File copied: {} -> {}", src, dst),
                json!({
                    "tool": tool_name,
                    "src": src,
                    "dst": dst,
                    "bytesCopied": result.get("bytes_copied").and_then(|v| v.as_u64()).unwrap_or(0),
                    "overwrite": args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }
        "fs_delete" => {
            let removed = result
                .get("removed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if removed {
                let path = result
                    .get("path")
                    .and_then(|v| v.as_str())
                    .or_else(|| args.get("path").and_then(|v| v.as_str()))
                    .unwrap_or("<unknown>");
                let kind = result
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path");
                receipt = Some((
                    BuildReceiptKind::FileDelete,
                    format!("Deleted {}: {}", kind, path),
                    json!({
                        "tool": tool_name,
                        "path": path,
                        "kind": kind,
                        "recursive": result.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false),
                    }),
                ));
            }
        }
        _ => {}
    }

    let Some((kind, summary, data)) = receipt else {
        return;
    };
    append_build_host_receipt(
        ctx,
        tab_id,
        tool_name,
        BuildHostReceipt {
            kind,
            actor: "shellx-host-mcp",
            summary,
            confidence: BuildReceiptConfidence::TrustedHost,
            data,
        },
    )
    .await;
}

pub(super) async fn post_build_receipt_to_debug_api(
    tab_id: &str,
    kind: crate::build_types::BuildReceiptKind,
    actor: &str,
    summary: String,
    confidence: crate::build_types::BuildReceiptConfidence,
    data: Value,
) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = crate::debug_api::current_debug_token()?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!("http://127.0.0.1:{}/build/receipt", port.trim());
    let body = json!({
        "tabId": tab_id,
        "kind": kind,
        "summary": summary,
        "actor": actor,
        "confidence": confidence,
        "data": data,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), send)
        .await
        .map_err(|_| "debug-api receipt post timed out".to_string())?
        .map_err(|e| format!("debug-api receipt post failed: {}", e))?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!(
            "debug-api receipt post returned {}: {}",
            status, text
        ))
    }
}

pub(super) async fn post_build_complete_to_debug_api(
    tab_id: &str,
    summary: &str,
) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = crate::debug_api::current_debug_token()?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!("http://127.0.0.1:{}/build/complete", port.trim());
    let body = json!({
        "tabId": tab_id,
        "summary": summary,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), send)
        .await
        .map_err(|_| "debug-api build_complete post timed out".to_string())?
        .map_err(|e| format!("debug-api build_complete post failed: {}", e))?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!(
            "debug-api build_complete returned {}: {}",
            status, text
        ))
    }
}

pub(super) async fn record_build_agent_completion_from_poll(
    value: &Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
) {
    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if status == "running" {
        return;
    }
    let Some(persona) = value.get("persona").and_then(|v| v.as_str()) else {
        return;
    };
    let task = value
        .get("task_preview")
        .and_then(|v| v.as_str())
        .unwrap_or(tool_name);
    let subagent_id = value
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let meta =
        match build_agent_receipt_key_for_current_run(ctx, tab_id, tool_name, subagent_id).await {
            Some(key) => remembered_build_agent_receipt_meta(&key)
                .await
                .unwrap_or_default(),
            None => BuildAgentReceiptMeta::default(),
        };
    record_build_agent_receipt(
        BuildAgentReceiptEvent::Completed(value),
        persona,
        task,
        meta,
        value.get("cwd").and_then(|v| v.as_str()),
        ctx,
        tab_id,
    )
    .await;
}

pub(super) async fn maybe_start_build_agent_completion_watcher(
    value: Option<&Value>,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    let Some(subagent_id) = value
        .and_then(|v| v.get("subagent_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some((_orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await else {
        return;
    };
    if !build_agent_completion_watcher_should_track(state.status) {
        return;
    }

    let key = build_agent_watcher_key(&state.run_id, subagent_id);
    if !reserve_build_agent_watcher(key.clone()).await {
        return;
    }

    let ctx = Arc::clone(ctx);
    let tab = tab.to_string();
    let subagent_id = subagent_id.to_string();
    let persona = persona.to_string();
    let task = task.to_string();
    let cwd = cwd.map(str::to_string);
    let watcher_key = key.clone();
    let watcher_task = tokio::spawn(async move {
        use futures_util::FutureExt as _;

        let watcher = run_build_agent_completion_watcher(BuildAgentCompletionWatcher {
            ctx,
            tab,
            subagent_id,
            persona,
            task,
            meta,
            cwd,
        });
        if std::panic::AssertUnwindSafe(watcher)
            .catch_unwind()
            .await
            .is_err()
        {
            tracing::error!(
                "host_mcp: build agent completion watcher panicked: {}",
                watcher_key
            );
        }
        unregister_build_agent_watcher(&watcher_key).await;
    });
    let _ = attach_build_agent_watcher_task(&key, watcher_task).await;
}
