use super::*;

pub(super) async fn tool_capabilities_summary(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let session = tool_get_session_info(ctx, tab_id)
        .await
        .unwrap_or_else(|e| json!({ "error": e }));
    Ok(json!({
        "kind": "shellx_capabilities_summary",
        "session": session,
        "firstCallGuidance": [
            "Use get_session_info for cwd and transport before choosing local/WSL/SSH file paths.",
            "Native provider/ACP file tools operate in the selected session cwd; ShellX host fs_* tools always operate on the ShellX parent host filesystem, even when the provider tab is WSL/SSH.",
            "Use model_instruction_cards before named provider/media handoffs such as Grok Imagine, Codex CLI, Claude Code, or Antigravity.",
            "Use provider_adapters and provider_sessions for provider CLI preflight and resume state.",
            "When the user explicitly asks to create, schedule, or create-and-run a Task, search for task_manage and call it through permission-gated host_act. Ordinary Task discussion is not authorization.",
            "Use search_tool with a targeted query for an exact Host action schema, then call host_read or permission-gated host_act with those fields under params.",
            "Avoid full_inventory as routine discovery; it is large and Grok may store it as a session artifact."
        ],
        "userDirectedRouting": {
            "tool": "model_instruction_cards",
            "handoffTools": ["send_prompt_to_session", "send_prompt_to_provider"],
            "healthTools": ["provider_adapters", "provider_sessions", "session_tooling"],
            "rule": "ShellX exposes provider/tool cards and health checks, but does not silently choose another provider. User-approved handoffs may start Grok/ACP through send_prompt_to_session or Codex/Claude/Antigravity provider CLIs through send_prompt_to_provider.",
            "fallback": "If a named provider is unavailable, report the failed preflight and ask before using another provider."
        },
        "qualifiedNameRule": {
            "preferredForMutations": "shellx-host-http__host_act with action+params",
            "readOnlyOrFallback": "shellx-host-http__host_read with action+params",
            "why": "The HTTP MCP transport carries the active tab and permission gate for write-class and tab-aware host tools."
        },
        "nativeTools": {
            "good": ["read_file", "write", "search_replace", "list_dir", "grep", "search_tool", "web_fetch", "web_search", "todo_write"],
            "preferredForRoutineProjectFiles": ["read_file", "write", "search_replace", "list_dir", "grep"],
            "useWithCare": ["scheduler_*", "enter_plan_mode", "exit_plan_mode", "image_gen", "video_gen", "image_edit"],
            "avoidInShellxAcp": ["run_terminal_command", "monitor", "task", "get_or_wait_for_command_subagent_output", "wait_for_commands_or_subagents", "kill_command_or_subagent", "ask_user_question"]
        },
        "fileToolGuidance": {
            "routineProjectFiles": "Use native provider/ACP read/write/search/list tools first in the active session cwd.",
            "hostFsExecution": "ShellX host fs_* tools execute on the ShellX parent host filesystem, not automatically on the SSH/WSL provider machine.",
            "useHostFsFor": ["atomic large or hot writes on the parent host", "binary/base64 reads or writes on the parent host", "Windows parent-host paths from WSL/SSH sessions", "explicit shellX host permission/audit", "fs_watch notifications", "copy/delete helpers"],
            "remotePosixPaths": "For WSL/SSH /home/... or /Users/... paths, use the provider's native file tools unless the user explicitly asks for parent-host files."
        },
        "hostToolCategories": [
            { "category": "orientation", "tools": ["capabilities_summary", "search_tool", "host_read", "host_act"], "note": "Only the compact gateways are always advertised. Search the exact legacy action schema, then place its fields inside params." },
            { "category": "providers", "tools": ["provider_adapters", "provider_sessions", "send_prompt_to_session", "send_prompt_to_provider"], "note": "Provider CLI health/session state plus explicit user-approved handoff into Grok/ACP or provider CLI sessions on a connected target or the visible tab." },
            { "category": "tasks", "tools": ["task_manage"], "note": "Explicit natural-language Task creation from the current ShellX conversation. ShellX derives the caller environment and permissions and verifies the ordered ready workers; the header Tasks panel reviews the saved definition and receipts." },
            { "category": "status", "tools": ["shellx_health", "session_tooling", "environment", "grok_environment", "event_log"], "note": "Use these for health, MCP/tool status, trace availability, and UI-visible audit events. Prefer environment; grok_environment is a compatibility alias." },
            { "category": "filesystem", "tools": ["fs_exists", "fs_stat", "fs_read", "fs_read_binary", "fs_write", "fs_append", "fs_copy", "fs_delete", "fs_list_dir", "fs_grep", "fs_watch", "fs_unwatch"], "note": "Discover the exact fs_* schema, then route reads through host_read and mutations through host_act. Host fs_* executes on the ShellX parent host filesystem. fs_read returns a 16 KiB page by default; continue from next_offset_bytes only when needed. Use native provider/ACP file tools for routine files in the active local/WSL/SSH cwd." },
            { "category": "process", "tools": ["process_list", "process_stats", "process_attach_stdout", "process_signal"] },
            { "category": "secrets", "tools": ["vault_list", "vault_list_grants", "vault_request_grant", "vault_agent_request", "secret_get", "secret_set", "secret_delete", "vault_generate", "vault_deposit"], "note": "Use vault_list for agent-visible key names/descriptions, then vault_request_grant for a pending human approval. vault_generate is a permission-gated create-only mutation that generates and stores a password without returning it; it never overwrites an existing item. For an exact executable with Vault-to-environment bindings, discover vault_agent_request through targeted search_tool; its larger schema is searchable rather than advertised. Poll status; approval is UI/Tauri-only. Raw Vault secret reveal is denied by default." },
            { "category": "agents", "tools": ["Agent", "Agent_status", "Agent_output", "Agent_poll_all", "Agent_kill", "Agent_metrics"], "personas": crate::subagent::PERSONA_NAMES },
            { "category": "build", "tools": ["build_state", "build_receipts", "build_receipt", "build_checkpoint", "build_complete"] },
            { "category": "preview", "tools": ["preview_start", "preview_state", "preview_logs", "preview_diagnose"], "note": "For UI/web/Expo work use shellX Work Preview before build_complete." },
            { "category": "browser", "tools": ["browser_read", "browser_act"], "note": "Use browser_read action=tabs, browser_act action=navigate, then browser_read action=observe for token-budgeted stable refs. Prefer refs; use coordinates only after screenshot evidence and Browser/Vault actions for secrets. browser_act action=runSteps batches a short route. Flight Recorder uses permission-gated flightRecorderExport/evaluationWrite plus caller-scoped browser_read action=evidence. Use targeted search_tool queries for exact uncommon fields and keep bounded evidence in ShellX storage." },
            { "category": "videoEditing", "tools": ["cut_read", "cut_act"], "note": "Use cut_read status/search/schema to discover one exact installed ShellX Cut verb, then permission-gated cut_act to execute it through the running editor. The large generated Cut catalog remains internal and cached instead of entering every provider prompt." },
            { "category": "mediaAndSearch", "tools": ["vision_describe", "voice_stt_v2", "voice_tts", "x_search", "net_fetch"] },
            { "category": "memoryAndTime", "tools": ["mem_set", "mem_get", "mem_list", "mem_delete", "clock_now", "sleep_ms"] },
            { "category": "security", "tools": ["security_scan"] }
        ],
        "marketplaceDiscovery": {
            "prefixPattern": "shellx-mp-*",
            "commonServers": ["shellx-mp-playwright", "shellx-mp-context7", "shellx-mp-fetch", "shellx-mp-git", "shellx-mp-memory"],
            "rule": "Use native search_tool for exact marketplace tool names and schemas; do not assume an installed connector is healthy until session tooling or Environment reports it."
        },
        "buildGateRule": "Do not use upstream task-based /check-work, /best-of-n, /execute-plan, /implement, /review, or /design as shellX /build hard gates. Use shellX Agent receipts plus Preview Doctor evidence.",
    }))
}

pub(super) async fn tool_model_instruction_cards() -> Result<Value, String> {
    let state = crate::model_instruction_cards::model_instruction_cards_state();
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!(
                "{} model instruction cards; routing mode {}; ShellX auto-route={}",
                state.cards.len(),
                state.policy.default_route_mode,
                state.policy.shellx_may_auto_route
            )
        }],
        "structuredContent": state,
        "isError": false
    }))
}

pub(super) async fn tool_provider_adapters(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let tab = mcp_arg_tab_id(&args).or_else(|| {
        tab_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    let explicit_transport = mcp_arg_transport(&args);
    let explicit_wsl_distro = mcp_arg_wsl_distro(&args);
    let explicit_ssh_host = mcp_arg_ssh_host(&args);
    let explicit_ssh_port = mcp_arg_ssh_port(&args);
    let explicit_ssh_key_vault_ref = mcp_arg_ssh_key_vault_ref(&args);
    let (path, transport_source) = match explicit_transport.as_deref() {
        Some(transport) => (
            provider_state_path(
                "/provider-adapters/state",
                Some(transport),
                explicit_wsl_distro.as_deref(),
                explicit_ssh_host.as_deref(),
                explicit_ssh_port,
                explicit_ssh_key_vault_ref.as_deref(),
            ),
            "explicitArgs".to_string(),
        ),
        None => {
            let inferred = match tab.as_deref() {
                Some(tab) => infer_provider_cli_handoff_target_for_tab(tab).await,
                None => None,
            };
            match inferred {
                Some(target) => (
                    provider_state_path(
                        "/provider-adapters/state",
                        Some(&target.transport),
                        target.wsl_distro.as_deref(),
                        target.ssh_host.as_deref(),
                        target.ssh_port,
                        target.ssh_key_vault_ref.as_deref(),
                    ),
                    target.source,
                ),
                None => (
                    "/provider-adapters/state".to_string(),
                    "defaultLocal".to_string(),
                ),
            }
        }
    };
    let mut data = debug_api_get_json(&path, 10).await?;
    if let Some(obj) = data.as_object_mut() {
        if let Some(tab) = tab {
            obj.insert("tabId".to_string(), json!(tab));
        }
        obj.insert("transportSource".to_string(), json!(transport_source));
    }
    let count = data
        .get("providers")
        .and_then(|v| v.as_array())
        .map(|providers| providers.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("provider adapter state: {} providers", count) }],
        "structuredContent": data,
        "isError": false
    }))
}

pub(super) async fn tool_provider_sessions(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "provider_sessions")?;
    let path = provider_sessions_state_path(
        &tab,
        mcp_arg_transport(&args).as_deref(),
        mcp_arg_wsl_distro(&args).as_deref(),
        mcp_arg_ssh_host(&args).as_deref(),
        mcp_arg_ssh_port(&args),
        mcp_arg_ssh_key_vault_ref(&args).as_deref(),
    );
    let data = debug_api_get_json(&path, 10).await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("provider_sessions for {}", tab) }],
        "structuredContent": data,
        "isError": false
    }))
}
