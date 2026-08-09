use super::*;

pub(crate) fn patch_goal_complete_status(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut saw_top_status = false;
    let mut before_first_phase = true;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if before_first_phase && trimmed.starts_with("## Phase") {
            if !saw_top_status {
                out.push("status: GOAL_COMPLETE".to_string());
                out.push(String::new());
                saw_top_status = true;
            }
            before_first_phase = false;
        }

        if before_first_phase
            && !saw_top_status
            && trimmed.to_ascii_lowercase().starts_with("status:")
        {
            let indent_len = line.len().saturating_sub(trimmed.len());
            let indent = &line[..indent_len];
            out.push(format!("{}status: GOAL_COMPLETE", indent));
            saw_top_status = true;
            continue;
        }

        out.push(line.to_string());
    }

    if !saw_top_status {
        out.insert(0, String::new());
        out.insert(0, "status: GOAL_COMPLETE".to_string());
    }

    let mut patched = out.join("\n");
    if text.ends_with('\n') {
        patched.push('\n');
    }
    patched
}

// goal_complete tool. Validates the per-tab scratchboard
// (every Phase status:DONE + every - [ ] flipped). Rejects with a
// specific failure list when grok claims completion prematurely.
//
// Tab resolution: tab_id is plumbed from the MCP-Tab-Id HTTP header
// via dispatch_to_value_with_tab_id. Stdio standalone clients pass
// None — they can't carry a tab id, so the tool errors with a clear
// message rather than silently picking "default".
//
// Failure shape: returns a structured error so grok sees actionable
// detail. Per MCP spec, returning `isError: true` + a text content
// block is the correct shape for tool-level failures (vs JSON-RPC
// errors which signal protocol-level issues). We use the text-block
// form so the failure list appears verbatim in grok's tool-output
// context.
pub(super) async fn tool_goal_complete(
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
        return Err(
            "goal_complete: 'summary' is required (short description of what was delivered)"
                .to_string(),
        );
    }

    // (#349): stdio MCP doesn't carry headers, so the per-call
    // tab_id arrives as None. Fall back to the SHELLX_HOST_MCP_TAB_ID
    // env var that `inject_host_mcp_server` writes into the spawn env
    // when it knows the calling tab. HTTP MCP path (WSL/SSH) keeps
    // using the MCP-Tab-Id header — header beats env when both present.
    let tab = match tab_id {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => match std::env::var("SHELLX_HOST_MCP_TAB_ID") {
            Ok(t) if !t.is_empty() => t,
            _ => {
                return Err(
                    "goal_complete: no tab identity available — neither the MCP-Tab-Id header (HTTP transport) nor the SHELLX_HOST_MCP_TAB_ID env (stdio transport) was set. shellX must thread the active tab id at host-MCP spawn time."
                        .to_string(),
                );
            }
        },
    };

    // Stdio standalone path (#353 fix): the MCP child can't reach the
    // Tauri-managed GoalOrchestrator. But the validator itself is a pure
    // function over the scratchboard text — read goal.md from cwd, run
    // `validate_board_text`, and (if it passes) write `status:
    // GOAL_COMPLETE` to the file directly. The main-process orchestrator
    // (which DOES run consider_continue with disk-read scratchboard parse)
    // sees GOAL_COMPLETE on next prompt-complete and stops auto-continuing.
    // This makes the gate work end-to-end on Local Windows where the host
    // MCP runs via stdio and has no Tauri AppHandle access.
    if ctx.app_handle.is_none() {
        let cwd = std::env::current_dir()
            .map_err(|e| format!("goal_complete: cwd unavailable: {}", e))?;
        let candidates = ["goal.md", "plan.md"];
        let mut found: Option<std::path::PathBuf> = None;
        for c in &candidates {
            let p = cwd.join(c);
            if p.exists() {
                found = Some(p);
                break;
            }
        }
        let path = found.ok_or_else(|| {
            format!(
                "goal_complete: no goal.md or plan.md in cwd {} — write the scratchboard first.",
                cwd.display()
            )
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("goal_complete: read {}: {}", path.display(), e))?;
        match crate::goal_orchestrator::validate_board_text(&text) {
            Ok(()) => {
                let new_text = patch_goal_complete_status(&text);
                std::fs::write(&path, new_text)
                    .map_err(|e| format!("goal_complete: write {}: {}", path.display(), e))?;
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "goal_complete accepted (stdio path). Summary: {}\n\nScratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations will stop on next prompt-complete cycle.",
                            summary, path.display()
                        ),
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
        .try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .ok_or_else(|| {
            "goal_complete: GoalOrchestrator is not registered on this Tauri app — feature disabled in this build.".to_string()
        })?;
    let orch = orch_state.inner().clone();

    // SSH transport: the authoritative scratchboard lives on the
    // remote machine where grok is executing. The in-process
    // orchestrator's normal reader can see local paths and WSL UNC
    // paths, but it cannot read `/home/<remote>/...` directly from the
    // Windows host. Validate and patch the remote file through the
    // tab's SSH config, then mark the in-process goal complete.
    let ssh_cfg =
        if let Some(reg_state) = app_handle.try_state::<Arc<crate::acp::SessionRegistry>>() {
            let reg = reg_state.inner().clone();
            if let Some(sess_arc) = reg.get_existing(&tab).await {
                let guard = sess_arc.lock().await;
                guard.ssh_config().cloned()
            } else {
                None
            }
        } else {
            None
        };
    if let Some(ssh) = ssh_cfg {
        let Some(state) = orch.get_state(&tab).await else {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": "goal_complete: no /goal active for this tab",
                }],
                "isError": true
            }));
        };
        if !state.active {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": "goal_complete: goal mode is not active for this tab",
                }],
                "isError": true
            }));
        }
        let remote_path = state.scratchboard_path.to_string_lossy().to_string();
        let text = match crate::acp::ssh_read_file(&ssh, &remote_path).await {
            Ok(t) => t,
            Err(e) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("goal_complete: could not read SSH scratchboard at {}: {}", remote_path, e),
                    }],
                    "isError": true
                }));
            }
        };
        match crate::goal_orchestrator::validate_board_text(&text) {
            Ok(()) => {
                let patched = patch_goal_complete_status(&text);
                if let Err(e) = crate::acp::ssh_write_file(&ssh, &remote_path, &patched).await {
                    return Ok(json!({
                        "content": [{
                            "type": "text",
                            "text": format!("goal_complete: SSH scratchboard validated but patch write failed at {}: {}", remote_path, e),
                        }],
                        "isError": true
                    }));
                }
                orch.mark_complete(&tab).await;
                let payload = serde_json::json!({
                    "kind": "goal_complete",
                    "tabId": tab,
                    "summary": summary,
                    "transport": "ssh",
                });
                let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "goal_complete accepted over SSH. Summary: {}\n\nRemote scratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations are now OFF for this tab.",
                            summary, remote_path
                        ),
                    }],
                    "isError": false
                }));
            }
            Err(reason) => {
                if crate::goal_orchestrator::goal_complete_refusal_requires_halt(&reason) {
                    orch.halt_for_system_reason(&tab, &reason).await;
                    let payload = serde_json::json!({
                        "kind": "goal_halted",
                        "tabId": tab,
                        "reason": reason,
                        "source": "goal_complete",
                        "transport": "ssh",
                    });
                    let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
                }
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

    match orch.validate_scratchboard_complete(&tab).await {
        Ok(()) => {
            let Some(state) = orch.get_state(&tab).await else {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": "goal_complete: no /goal active for this tab",
                    }],
                    "isError": true
                }));
            };
            let text = match crate::goal_orchestrator::read_scratchboard_text_for_transport(
                &state.scratchboard_path,
                &state.transport_kind,
                state.ssh_config.as_ref(),
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    return Ok(json!({
                        "content": [{
                            "type": "text",
                            "text": format!("goal_complete: scratchboard validated but re-read failed before patching {}: {}", state.scratchboard_path.display(), e),
                        }],
                        "isError": true
                    }));
                }
            };
            let patched = patch_goal_complete_status(&text);
            if let Err(e) = crate::goal_orchestrator::write_scratchboard_text_for_transport(
                &state.scratchboard_path,
                &patched,
                &state.transport_kind,
                state.ssh_config.as_ref(),
            )
            .await
            {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("goal_complete: scratchboard validated but patch write failed at {}: {}", state.scratchboard_path.display(), e),
                    }],
                    "isError": true
                }));
            }
            orch.mark_complete(&tab).await;
            // Emit a typed goal-event so the UI can flip the goal pane
            // into the COMPLETE state without scraping the firehose.
            let payload = serde_json::json!({
                "kind": "goal_complete",
                "tabId": tab,
                "summary": summary,
            });
            let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!(
                        "goal_complete accepted. Summary: {}\n\nScratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations are now OFF for this tab.",
                        summary,
                        state.scratchboard_path.display()
                    ),
                }],
                "isError": false
            }))
        }
        Err(reason) => {
            // MCP convention: tool-level failures use isError + a text
            // content block, NOT a JSON-RPC error. grok will see this in
            // its tool-output context and (per the continuation prompt's
            // instructions) keep working until the scratchboard actually
            // proves complete.
            if crate::goal_orchestrator::goal_complete_refusal_requires_halt(&reason) {
                orch.halt_for_system_reason(&tab, &reason).await;
                let payload = serde_json::json!({
                    "kind": "goal_halted",
                    "tabId": tab,
                    "reason": reason,
                    "source": "goal_complete",
                });
                let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
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
