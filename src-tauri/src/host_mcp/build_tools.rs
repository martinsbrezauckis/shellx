use super::*;

pub(super) fn build_agent_completion_watcher_should_track(
    status: crate::build_types::BuildRunStatus,
) -> bool {
    !build_status_is_terminal(&status)
}

pub(super) fn build_agent_gate_kind_for_persona(
    persona: &str,
) -> Option<crate::build_types::BuildReceiptKind> {
    match persona {
        "reviewer" => Some(crate::build_types::BuildReceiptKind::ReviewCompleted),
        "verifier" => Some(crate::build_types::BuildReceiptKind::VerificationCompleted),
        _ => None,
    }
}

pub(super) fn resolve_mcp_tab_id(tab_id: Option<&str>, tool_name: &str) -> Result<String, String> {
    match tab_id {
        Some(t) if !t.is_empty() => Ok(t.to_string()),
        _ => match std::env::var("SHELLX_HOST_MCP_TAB_ID") {
            Ok(t) if !t.is_empty() => Ok(t),
            _ => Err(format!(
                "{}: no tab identity available — neither the MCP-Tab-Id header nor SHELLX_HOST_MCP_TAB_ID env was set",
                tool_name
            )),
        },
    }
}

pub(super) async fn post_build_checkpoint_to_debug_api(
    tab_id: &str,
    cwd: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/state/session_git/checkpoint",
        port.trim()
    );
    let body = json!({
        "tabId": tab_id,
        "cwd": cwd,
        "label": label,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), send)
        .await
        .map_err(|_| "debug-api checkpoint post timed out".to_string())?
        .map_err(|e| format!("debug-api checkpoint post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api checkpoint JSON: {}", e))
    } else {
        Err(format!(
            "debug-api checkpoint returned {}: {}",
            status, text
        ))
    }
}

pub(super) async fn post_preview_diagnose_to_debug_api(
    tab_id: &str,
    body: Value,
) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/preview/work/diagnose?tabId={}",
        port.trim(),
        encode_query_component(tab_id)
    );
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(75), send)
        .await
        .map_err(|_| "debug-api preview_diagnose post timed out".to_string())?
        .map_err(|e| format!("debug-api preview_diagnose post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api preview_diagnose JSON: {}", e))
    } else {
        Err(format!(
            "debug-api preview_diagnose returned {}: {}",
            status, text
        ))
    }
}

pub(super) async fn post_preview_start_to_debug_api(
    tab_id: &str,
    body: Value,
) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/preview/work/start?tabId={}",
        port.trim(),
        encode_query_component(tab_id)
    );
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(240), send)
        .await
        .map_err(|_| "debug-api preview_start post timed out".to_string())?
        .map_err(|e| format!("debug-api preview_start post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api preview_start JSON: {}", e))
    } else {
        Err(format!(
            "debug-api preview_start returned {}: {}",
            status, text
        ))
    }
}

pub(super) fn encode_query_component(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", byte));
        }
    }
    out
}

pub(super) fn build_receipt_kind_from_str(
    raw: &str,
) -> Option<crate::build_types::BuildReceiptKind> {
    match raw {
        "reviewCompleted" => Some(crate::build_types::BuildReceiptKind::ReviewCompleted),
        "verificationCompleted" => {
            Some(crate::build_types::BuildReceiptKind::VerificationCompleted)
        }
        "previewDiagnosed" => Some(crate::build_types::BuildReceiptKind::PreviewDiagnosed),
        "blockerOpened" => Some(crate::build_types::BuildReceiptKind::BlockerOpened),
        "blockerResolved" => Some(crate::build_types::BuildReceiptKind::BlockerResolved),
        _ => None,
    }
}

pub(super) async fn tool_build_checkpoint(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id(tab_id, "build_checkpoint")?;
    let label = args
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let snapshot = if let Some(app_handle) = &ctx.app_handle {
        let registry = app_handle
            .try_state::<Arc<crate::acp::SessionRegistry>>()
            .ok_or_else(|| "build_checkpoint: SessionRegistry is not registered".to_string())?;
        let build_orch = app_handle
            .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .ok_or_else(|| "build_checkpoint: BuildOrchestrator is not registered".to_string())?;
        let provider_context = app_handle
            .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            .and_then(|provider_registry| {
                crate::session_git::git_provider_context_for_tab(provider_registry.inner(), &tab)
            });
        serde_json::to_value(
            crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
                registry.inner().clone(),
                build_orch.inner().clone(),
                Some(tab.clone()),
                cwd,
                label,
                provider_context,
            )
            .await?,
        )
        .map_err(|e| format!("build_checkpoint response serialize: {}", e))?
    } else {
        post_build_checkpoint_to_debug_api(&tab, cwd, label).await?
    };

    if snapshot.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let message = snapshot
            .get("lastError")
            .or_else(|| snapshot.get("last_error"))
            .and_then(|v| v.as_str())
            .unwrap_or("checkpoint creation failed");
        return Err(format!("build_checkpoint: {}", message));
    }
    let checkpoint_id = snapshot
        .get("checkpoint")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)");
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("build checkpoint created for /build tab {}: {}", tab, checkpoint_id),
        }],
        "structuredContent": snapshot,
        "isError": false
    }))
}

pub(super) async fn resolve_preview_cwd(ctx: &Arc<HostMcpContext>, tab: &str) -> Option<String> {
    use tauri::Manager as _;

    let app_handle = ctx.app_handle.as_ref()?;
    let registry = app_handle.try_state::<Arc<crate::acp::SessionRegistry>>()?;
    let session = registry.get_existing(tab).await?;
    let guard = session.lock().await;
    let info = guard.get_debug_session_info();
    info.get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) async fn tool_build_state(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "build_state")?;
    let data = debug_api_get_json(
        &format!("/build/state?tabId={}", encode_query_component(&tab)),
        10,
    )
    .await?;
    let status = data
        .get("state")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    Ok(json!({
        "content": [{ "type": "text", "text": format!("build_state for {}: {}", tab, status) }],
        "structuredContent": data,
        "isError": false
    }))
}

pub(super) async fn tool_build_receipts(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "build_receipts")?;
    let data = debug_api_get_json_optional_not_found(
        &format!("/build/receipts?tabId={}", encode_query_component(&tab)),
        10,
    )
    .await?
    .unwrap_or_else(|| {
        json!({
            "ok": true,
            "tabId": tab.clone(),
            "receipts": []
        })
    });
    let count = data
        .get("receipts")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("build_receipts for {}: {}", tab, count) }],
        "structuredContent": data,
        "isError": false
    }))
}

pub(super) async fn tool_preview_state(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "preview_state")?;
    let state = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_state: WorkPreviewManager is not registered".to_string())?;
        serde_json::to_value(manager.state(&tab).await)
            .map_err(|e| format!("preview_state response encode: {}", e))?
    } else {
        debug_api_get_json(
            &format!("/preview/work/state?tabId={}", encode_query_component(&tab)),
            10,
        )
        .await?
    };
    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    Ok(json!({
        "content": [{ "type": "text", "text": format!("preview_state for {}: {}", tab, status) }],
        "structuredContent": state,
        "isError": status == "failed"
    }))
}

pub(super) async fn tool_preview_logs(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "preview_logs")?;
    let logs = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_logs: WorkPreviewManager is not registered".to_string())?;
        json!({
            "tabId": tab.clone(),
            "logs": manager.logs(&tab).await,
        })
    } else {
        debug_api_get_json(
            &format!("/preview/work/logs?tabId={}", encode_query_component(&tab)),
            10,
        )
        .await?
    };
    let count = logs
        .get("logs")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("preview_logs for {}: {} line(s)", tab, count) }],
        "structuredContent": logs,
        "isError": false
    }))
}

pub(super) async fn tool_preview_start(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;

    let tab = args
        .get("tabId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(resolve_mcp_tab_id(tab_id, "preview_start")?);
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let cwd = match cwd {
        Some(cwd) => cwd,
        None => resolve_preview_cwd(ctx, &tab)
            .await
            .unwrap_or_else(|| ctx.cwd.display().to_string()),
    };
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    let entry = args
        .get("entry")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let mut body = json!({
        "tabId": tab,
        "cwd": cwd,
        "kind": kind,
    });
    if let Some(entry) = entry {
        body["entry"] = Value::String(entry);
    }

    let state = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_start: WorkPreviewManager is not registered".to_string())?;
        let request: crate::work_preview::WorkPreviewStartRequest =
            serde_json::from_value(body.clone())
                .map_err(|e| format!("preview_start request decode: {}", e))?;
        serde_json::to_value(
            manager
                .start(request)
                .await
                .map_err(|e| format!("preview_start: {}", e))?,
        )
        .map_err(|e| format!("preview_start response encode: {}", e))?
    } else {
        post_preview_start_to_debug_api(
            body.get("tabId")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            body.clone(),
        )
        .await?
    };

    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let text = if let Some(url) = state.get("url").and_then(|v| v.as_str()) {
        format!("Work Preview {} at {}", status, url)
    } else if let Some(error) = state.get("error").and_then(|v| v.as_str()) {
        format!("Work Preview {}: {}", status, error)
    } else {
        format!("Work Preview {}", status)
    };
    Ok(json!({
        "content": [{
            "type": "text",
            "text": text,
        }],
        "structuredContent": state,
        "isError": status == "failed"
    }))
}

pub(super) async fn tool_preview_diagnose(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = args
        .get("tabId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(resolve_mcp_tab_id(tab_id, "preview_diagnose")?);
    let body = json!({
        "tabId": tab,
        "browserEvents": args.get("browserEvents").cloned().unwrap_or_else(|| json!([])),
    });

    let diagnostic = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_diagnose: WorkPreviewManager is not registered".to_string())?;
        let request: crate::work_preview::WorkPreviewDiagnoseRequest =
            serde_json::from_value(body.clone())
                .map_err(|e| format!("preview_diagnose request decode: {}", e))?;
        serde_json::to_value(manager.diagnose(&tab, request).await)
            .map_err(|e| format!("preview_diagnose response encode: {}", e))?
    } else {
        post_preview_diagnose_to_debug_api(&tab, body).await?
    };

    let ok = diagnostic
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let summary = diagnostic
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("Preview Doctor completed");
    append_build_host_receipt(
        ctx,
        Some(tab.as_str()),
        "preview_diagnose",
        BuildHostReceipt {
            kind: crate::build_types::BuildReceiptKind::PreviewDiagnosed,
            actor: "shellx-preview-doctor",
            summary: summary.to_string(),
            confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
            data: diagnostic.clone(),
        },
    )
    .await;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": summary,
        }],
        "structuredContent": diagnostic,
        "isError": !ok
    }))
}

pub(super) async fn tool_build_receipt(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id(tab_id, "build_receipt")?;
    let kind_raw = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let kind = build_receipt_kind_from_str(kind_raw)
        .ok_or_else(|| format!("build_receipt: unsupported kind `{}`", kind_raw))?;
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err("build_receipt: summary is required".to_string());
    }
    let data = args.get("data").cloned().unwrap_or_else(|| json!({}));
    if ctx.app_handle.is_none() {
        post_build_receipt_to_debug_api(
            &tab,
            kind,
            "grok",
            summary.clone(),
            crate::build_types::BuildReceiptConfidence::ModelDeclared,
            data,
        )
        .await?;
        return Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("build_receipt recorded for /build tab {}: {}", tab, summary),
            }],
            "isError": false
        }));
    }
    let app_handle = ctx.app_handle.as_ref().expect("checked above");
    let orch_state = app_handle
        .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .ok_or_else(|| "build_receipt: BuildOrchestrator is not registered".to_string())?;
    let orch = orch_state.inner().clone();
    let state = orch
        .get_state(&tab)
        .await
        .ok_or_else(|| "build_receipt: no active /build run for this tab".to_string())?;
    orch.append_receipt(crate::build_types::BuildReceipt {
        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
        run_id: state.run_id,
        tab_id: tab.clone(),
        kind,
        created_at_ms: now_millis_for_build_receipt(),
        actor: "grok".into(),
        summary: summary.clone(),
        confidence: crate::build_types::BuildReceiptConfidence::ModelDeclared,
        data,
    })
    .await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("build_receipt recorded for /build tab {}: {}", tab, summary),
        }],
        "isError": false
    }))
}

pub(super) async fn tool_build_complete(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err("build_complete: 'summary' is required".to_string());
    }
    let tab = resolve_mcp_tab_id(tab_id, "build_complete")?;

    if ctx.app_handle.is_none() {
        match post_build_complete_to_debug_api(&tab, &summary).await {
            Ok(()) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("build_complete accepted. Summary: {}", summary),
                    }],
                    "isError": false
                }));
            }
            Err(reason) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": reason,
                    }],
                    "isError": true
                }));
            }
        }
    }

    let app_handle = ctx.app_handle.as_ref().expect("checked above");
    let orch_state = app_handle
        .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .ok_or_else(|| "build_complete: BuildOrchestrator is not registered".to_string())?;
    let orch = orch_state.inner().clone();
    let current_state = orch.get_state(&tab).await;
    let build_run_id = current_state.as_ref().map(|state| state.run_id.clone());
    let current_worktree_fingerprint = match current_state {
        Some(state) if state.code_changed && state.transport_kind.trim() != "local" => {
            let registry = app_handle
                .try_state::<Arc<crate::acp::SessionRegistry>>()
                .ok_or_else(|| "build_complete: SessionRegistry is not registered".to_string())?;
            let provider_context = app_handle
                .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
                .and_then(|provider_registry| {
                    crate::session_git::git_provider_context_for_tab(
                        provider_registry.inner(),
                        &tab,
                    )
                });
            crate::session_git::git_session_current_worktree_fingerprint_for_tab_with_provider(
                registry.inner().clone(),
                Some(tab.clone()),
                None,
                provider_context,
            )
            .await?
        }
        _ => None,
    };
    match orch
        .validate_complete_with_current_fingerprint(&tab, &summary, current_worktree_fingerprint)
        .await
    {
        Ok(()) => {
            let aborted_agent_watchers = match build_run_id.as_deref() {
                Some(run_id) => abort_build_agent_watchers_for_run(run_id).await,
                None => 0,
            };
            let payload = serde_json::json!({
                "kind": "build_complete",
                "tabId": tab,
                "summary": summary,
                "abortedAgentWatchers": aborted_agent_watchers,
            });
            let _ = tauri::Emitter::emit(app_handle, "build-event", payload);
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("build_complete accepted. Summary: {}", summary),
                }],
                "isError": false
            }))
        }
        Err(reason) => {
            if let Some(state) = orch.get_state(&tab).await {
                let _ = orch
                    .append_receipt(crate::build_types::BuildReceipt {
                        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
                        run_id: state.run_id,
                        tab_id: tab.clone(),
                        kind: crate::build_types::BuildReceiptKind::CompletionRejected,
                        created_at_ms: now_millis_for_build_receipt(),
                        actor: "shellx".into(),
                        summary: reason.clone(),
                        confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
                        data: json!({}),
                    })
                    .await;
            }
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": reason,
                }],
                "isError": true
            }))
        }
    }
}

pub(super) fn now_millis_for_build_receipt() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
