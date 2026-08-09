use super::*;

pub(super) async fn collect_debug_session_infos(s: &ApiState) -> Vec<serde_json::Value> {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_ids = registry.list_tabs().await;
    let mut tabs: Vec<serde_json::Value> = Vec::with_capacity(tab_ids.len());
    let mut seen_tabs = HashSet::new();
    for tab_id in &tab_ids {
        // Peek without creating; if the entry vanished mid-iter (rare
        // race with /abort) we just skip.
        let Some(sess_arc) = registry.get_existing(tab_id).await else {
            continue;
        };
        let sess = sess_arc.lock().await;
        // Reuse the existing serializer that /state/header builds on;
        // add a tabId field at the top for unambiguous mapping back
        // to the caller's table.
        let mut info = sess.get_debug_session_info();
        if let Some(provider_info) =
            active_provider_session_info_for_tab(&provider_registry, tab_id)
        {
            info = provider_info;
        }
        let has_classic_session = info
            .get("hasActiveChild")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
            || info
                .get("sessionId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
            || info
                .get("cwd")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
        if !has_classic_session
            && !info
                .get("hasProviderContext")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        {
            if let Some(provider_info) = provider_session_info_for_tab(&provider_registry, tab_id) {
                info = provider_info;
            }
        }
        if let serde_json::Value::Object(ref mut map) = info {
            map.insert(
                "tabId".to_string(),
                serde_json::Value::String(tab_id.clone()),
            );
        }
        seen_tabs.insert(tab_id.clone());
        tabs.push(info);
    }
    for run in provider_registry.runs_all_tabs() {
        if !seen_tabs.insert(run.tab_id.clone()) {
            continue;
        }
        let mut info = provider_session_info_from_run(&run);
        if let serde_json::Value::Object(ref mut map) = info {
            map.insert(
                "tabId".to_string(),
                serde_json::Value::String(run.tab_id.clone()),
            );
        }
        tabs.push(info);
    }
    tabs
}

pub(super) async fn state_sessions(State(s): State<ApiState>) -> impl IntoResponse {
    let tabs = collect_debug_session_infos(&s).await;
    Json(serde_json::json!({
        "count": tabs.len(),
        "tabs": tabs,
    }))
    .into_response()
}

pub(super) async fn state_tabs_report(State(s): State<ApiState>) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    let session_infos = collect_debug_session_infos(&s).await;
    Json(debug_tab_report_from_parts(&ui, session_infos, now_ms())).into_response()
}

#[derive(Deserialize)]
pub(super) struct AgentRunsQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(rename = "maxAgeMs", default)]
    max_age_ms: Option<i64>,
}

pub(super) async fn state_agent_runs(
    State(s): State<ApiState>,
    Query(q): Query<AgentRunsQuery>,
) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    let session_infos = collect_debug_session_infos(&s).await;
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let max_age_ms = q.max_age_ms.unwrap_or(30 * 60 * 1000);
    let subagent_rows = match crate::host_subagents::list_recent_read_only(Some(max_age_ms)) {
        Ok(rows) => rows,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "subagents_db_read_failed",
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    let events = s.hub().recent(RING_CAPACITY);
    let mut report = debug_agent_runs_report_from_parts(
        &ui,
        session_infos,
        provider_registry.runs_all_tabs(),
        subagent_rows,
        events,
        now_ms(),
    );
    if let Some(tab_id) = q
        .tab_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        report = debug_agent_runs_filter_report_to_tab(report, tab_id);
    }
    Json(report).into_response()
}

pub(super) fn debug_tab_report_from_parts(
    ui: &UiState,
    session_infos: Vec<serde_json::Value>,
    generated_at_ms: i64,
) -> serde_json::Value {
    let mut info_by_tab: HashMap<String, serde_json::Value> = HashMap::new();
    for info in session_infos {
        if let Some(tab_id) = json_str(&info, "tabId").filter(|value| !value.trim().is_empty()) {
            info_by_tab.insert(tab_id.to_string(), info);
        }
    }

    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for open in &ui.open_tabs {
        if open.tab_id.trim().is_empty() || !seen.insert(open.tab_id.clone()) {
            continue;
        }
        let info = info_by_tab.remove(&open.tab_id);
        rows.push(debug_tab_report_row(
            Some(open),
            info.as_ref(),
            ui.active_tab_id.as_deref(),
        ));
    }
    for (tab_id, info) in info_by_tab {
        if !seen.insert(tab_id) {
            continue;
        }
        rows.push(debug_tab_report_row(
            None,
            Some(&info),
            ui.active_tab_id.as_deref(),
        ));
    }

    let running_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| matches!(status, "running" | "starting" | "aborting"))
        })
        .count();
    let finished_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| status == "finished")
        })
        .count();
    let needs_attention_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| matches!(status, "failed" | "aborted"))
        })
        .count();

    serde_json::json!({
        "generatedAtMs": generated_at_ms,
        "activeTabId": ui.active_tab_id.clone(),
        "count": rows.len(),
        "runningCount": running_count,
        "finishedCount": finished_count,
        "needsAttentionCount": needs_attention_count,
        "tabs": rows,
    })
}

pub(super) fn debug_agent_runs_report_from_parts(
    ui: &UiState,
    session_infos: Vec<serde_json::Value>,
    provider_runs: Vec<crate::provider_sessions::ProviderRunSnapshot>,
    shellx_subagents: Vec<serde_json::Value>,
    events: Vec<RawEvent>,
    generated_at_ms: i64,
) -> serde_json::Value {
    let tab_report = debug_tab_report_from_parts(ui, session_infos, generated_at_ms);
    let native_rows = debug_observed_provider_native_subagent_rows(&events);
    let token_usage_by_run = debug_provider_token_usage_by_run(&events);
    let metrics_by_run = debug_provider_run_metrics_by_run(&events);
    let mut native_tabs = HashSet::new();
    for row in &native_rows {
        if let Some(tab_id) = json_str(row, "tabId") {
            native_tabs.insert(tab_id.to_string());
        }
    }

    let mut runs = Vec::new();
    let tab_rows = tab_report
        .get("tabs")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for tab in &tab_rows {
        let tab_id = json_str(tab, "tabId").unwrap_or("unknown");
        let agent_id = json_str(tab, "agentId").unwrap_or("unselected");
        let status = json_str(tab, "status").unwrap_or("idle");
        let provider_context = json_str(tab, "sessionKind") == Some("provider")
            || json_str(tab, "providerRunId").is_some()
            || matches!(agent_id, "codex-cli" | "claude-code" | "antigravity-cli");
        runs.push(serde_json::json!({
            "id": format!("tab:{tab_id}"),
            "kind": "tab-session",
            "scope": "shellx-tab",
            "tabId": tab_id,
            "title": tab.get("title").cloned().unwrap_or(serde_json::Value::Null),
            "agentId": agent_id,
            "agentLabel": tab.get("agentLabel").cloned().unwrap_or(serde_json::Value::Null),
            "status": status,
            "phase": tab.get("phase").cloned().unwrap_or(serde_json::Value::Null),
            "active": debug_agent_run_status_is_active(status),
            "focused": tab.get("isFocused").and_then(|value| value.as_bool()).unwrap_or(false),
            "surface": tab.get("surface").cloned().unwrap_or_else(|| serde_json::json!({})),
            "sessionId": tab.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
            "providerRunId": tab.get("providerRunId").cloned().unwrap_or(serde_json::Value::Null),
            "nativeVisibility": if native_tabs.contains(tab_id) {
                "observed"
            } else if provider_context {
                "notExposed"
            } else {
                "notApplicable"
            },
            "updatedAtMs": generated_at_ms,
        }));
    }

    for run in &provider_runs {
        let key = debug_provider_run_key(&run.tab_id, &run.run_id);
        let provider_id = run.provider_id.marker_id();
        let metrics = debug_provider_run_metrics_for_snapshot(run, metrics_by_run.get(&key));
        runs.push(serde_json::json!({
            "id": format!("provider:{}", run.run_id),
            "kind": "provider-run",
            "scope": "provider-cli",
            "tabId": run.tab_id,
            "runId": run.run_id,
            "processTaskId": run.process_task_id,
            "providerId": provider_id,
            "agentLabel": run.provider_id.label(),
            "status": debug_provider_phase_status(&run.phase),
            "phase": run.phase,
            "active": provider_run_is_active(run),
            "cwd": run.cwd,
            "surface": {
                "transport": provider_execution_transport_label(&run.transport),
                "cwd": run.cwd,
                "wslDistro": run.wsl_distro,
                "sshHost": run.ssh_host,
                "sshPort": run.ssh_port,
                "sshKeyVaultRef": run.ssh_key_vault_ref,
                "processTaskId": run.process_task_id,
            },
            "promptPreview": run.prompt_preview,
            "startedAtMs": run.started_at_ms,
            "updatedAtMs": run.updated_at_ms,
            "durationMs": run.duration_ms,
            "exitCode": run.exit_code,
            "error": run.error,
            "providerConversationId": run.provider_conversation_id,
            "permissionMode": run.permission_mode,
            "shellxToolExposure": run.shellx_tool_exposure,
            "stdoutLineCount": run.stdout_line_count,
            "stderrLineCount": run.stderr_line_count,
            "tokens": token_usage_by_run.get(&key).cloned().unwrap_or(serde_json::Value::Null),
            "metrics": metrics,
            "nativeVisibility": if native_tabs.contains(&run.tab_id) { "observed" } else { "notExposed" },
        }));
    }

    for row in &shellx_subagents {
        let id = json_str(row, "id").unwrap_or("unknown");
        let status = json_str(row, "status").unwrap_or("unknown");
        let started = row
            .get("startedUnixMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(generated_at_ms);
        let elapsed = row.get("elapsedMs").and_then(|value| value.as_i64());
        let updated = elapsed
            .map(|elapsed| started.saturating_add(elapsed))
            .unwrap_or(generated_at_ms);
        runs.push(serde_json::json!({
            "id": format!("shellx-subagent:{id}"),
            "kind": "shellx-host-subagent",
            "scope": "shellx-host",
            "tabId": row.get("tabId").cloned().unwrap_or(serde_json::Value::Null),
            "subagentId": id,
            "persona": row.get("persona").cloned().unwrap_or(serde_json::Value::Null),
            "taskPreview": row.get("taskPreview").cloned().unwrap_or(serde_json::Value::Null),
            "status": status,
            "active": status == "running",
            "pid": row.get("pid").cloned().unwrap_or(serde_json::Value::Null),
            "taskId": row.get("taskId").cloned().unwrap_or(serde_json::Value::Null),
            "startedAtMs": started,
            "updatedAtMs": updated,
            "elapsedMs": row.get("elapsedMs").cloned().unwrap_or(serde_json::Value::Null),
            "exitCode": row.get("exitCode").cloned().unwrap_or(serde_json::Value::Null),
            "tokens": row.get("totalTokens").cloned().unwrap_or(serde_json::Value::Null),
            "killed": row.get("killed").and_then(|value| value.as_bool()).unwrap_or(false),
            "nativeVisibility": "shellxHost",
        }));
    }

    runs.extend(native_rows);
    runs.sort_by(|a, b| {
        debug_agent_run_updated_at(b)
            .cmp(&debug_agent_run_updated_at(a))
            .then_with(|| {
                json_str(a, "id")
                    .unwrap_or("")
                    .cmp(json_str(b, "id").unwrap_or(""))
            })
    });

    let running_count = runs
        .iter()
        .filter(|row| {
            row.get("active")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .count();
    let provider_run_count = provider_runs.len();
    let shellx_subagent_count = shellx_subagents.len();
    let observed_native_count = runs
        .iter()
        .filter(|row| {
            json_str(row, "kind") == Some("provider-native-subagent")
                && json_str(row, "nativeVisibility") == Some("observed")
        })
        .count();
    let native_visibility = if observed_native_count > 0 {
        "observed"
    } else {
        "notExposed"
    };

    serde_json::json!({
        "generatedAtMs": generated_at_ms,
        "activeTabId": ui.active_tab_id.clone(),
        "summary": {
            "runCount": runs.len(),
            "runningCount": running_count,
            "tabSessionCount": tab_rows.len(),
            "providerRunCount": provider_run_count,
            "shellxSubagentCount": shellx_subagent_count,
            "observedNativeSubagentCount": observed_native_count,
        },
        "nativeSubagents": {
            "visibility": native_visibility,
            "observedCount": observed_native_count,
            "note": "Provider-native subagents are shown only when the provider CLI emits identifiable subagent/tool-use events.",
        },
        "runs": runs,
    })
}

pub(super) fn debug_agent_runs_filter_report_to_tab(
    mut report: serde_json::Value,
    tab_id: &str,
) -> serde_json::Value {
    let Some((
        run_count,
        running_count,
        provider_run_count,
        shellx_subagent_count,
        observed_native_count,
    )) = report
        .get_mut("runs")
        .and_then(|value| value.as_array_mut())
        .map(|runs| {
            runs.retain(|row| json_str(row, "tabId") == Some(tab_id));
            let running_count = runs
                .iter()
                .filter(|row| {
                    row.get("active")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                })
                .count();
            let provider_run_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("provider-run"))
                .count();
            let shellx_subagent_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("shellx-host-subagent"))
                .count();
            let observed_native_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("provider-native-subagent"))
                .count();
            (
                runs.len(),
                running_count,
                provider_run_count,
                shellx_subagent_count,
                observed_native_count,
            )
        })
    else {
        return report;
    };
    if let Some(summary) = report
        .get_mut("summary")
        .and_then(|value| value.as_object_mut())
    {
        summary.insert("runCount".to_string(), serde_json::json!(run_count));
        summary.insert("runningCount".to_string(), serde_json::json!(running_count));
        summary.insert(
            "providerRunCount".to_string(),
            serde_json::json!(provider_run_count),
        );
        summary.insert(
            "shellxSubagentCount".to_string(),
            serde_json::json!(shellx_subagent_count),
        );
        summary.insert(
            "observedNativeSubagentCount".to_string(),
            serde_json::json!(observed_native_count),
        );
    }
    if let Some(native) = report
        .get_mut("nativeSubagents")
        .and_then(|value| value.as_object_mut())
    {
        native.insert(
            "visibility".to_string(),
            serde_json::json!(if observed_native_count > 0 {
                "observed"
            } else {
                "notExposed"
            }),
        );
        native.insert(
            "observedCount".to_string(),
            serde_json::json!(observed_native_count),
        );
    }
    report
}

pub(super) fn debug_observed_provider_native_subagent_rows(
    events: &[RawEvent],
) -> Vec<serde_json::Value> {
    let mut row_indexes = HashMap::<String, usize>::new();
    let mut rows = Vec::<serde_json::Value>::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(provider_id) = json_str(&ev.payload, "providerId") else {
            continue;
        };
        let Some(tab_id) = json_str(&ev.payload, "tabId")
            .or_else(|| debug_asset_event_tab_id(ev))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let run_id = json_str(&ev.payload, "runId").unwrap_or("unknown");
        let raw_type = json_str(&ev.payload, "rawType").unwrap_or("");
        let event_kind = json_str(&ev.payload, "kind").unwrap_or("");
        let text = json_str(&ev.payload, "text").unwrap_or("");
        let tool_name = json_str(&ev.payload, "toolName").unwrap_or("");
        let subagent_id =
            json_str(&ev.payload, "subagentId").filter(|value| !value.trim().is_empty());
        let parent_subagent_id =
            json_str(&ev.payload, "parentSubagentId").filter(|value| !value.trim().is_empty());
        let tool_call_id =
            json_str(&ev.payload, "toolCallId").filter(|value| !value.trim().is_empty());
        let item_id = json_str(&ev.payload, "itemId").filter(|value| !value.trim().is_empty());
        let text_lower = text.to_ascii_lowercase();
        let raw_lower = raw_type.to_ascii_lowercase();
        let tool_lower = tool_name.to_ascii_lowercase();
        let looks_like_native_subagent = event_kind == "subagent"
            || subagent_id.is_some()
            || parent_subagent_id.is_some()
            || (provider_id == "claude-code" && event_kind == "tool" && text == "Task")
            || raw_lower.contains("subagent")
            || (matches!(event_kind, "tool" | "mcpTool" | "command")
                && (text_lower.contains("subagent") || tool_lower.contains("subagent")));
        if !looks_like_native_subagent {
            continue;
        }
        let label = if !tool_name.trim().is_empty() {
            tool_name.trim().chars().take(80).collect()
        } else if provider_id == "claude-code" && text == "Task" {
            "Claude Code native Task".to_string()
        } else if !text.trim().is_empty() {
            text.trim().chars().take(80).collect()
        } else if !raw_type.trim().is_empty() {
            raw_type.trim().to_string()
        } else {
            "provider-native subagent".to_string()
        };
        let identity = subagent_id
            .or(tool_call_id)
            .or(item_id)
            .unwrap_or(label.as_str());
        let key = format!("{tab_id}:{run_id}:{provider_id}:{identity}");
        let status = json_str(&ev.payload, "status").unwrap_or("observed");
        let active = matches!(status, "started" | "inProgress" | "waitingForApproval");
        if let Some(index) = row_indexes.get(&key).copied() {
            let row = &mut rows[index];
            let current_updated_at = row
                .get("updatedAtMs")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(i64::MIN);
            if ev.t >= current_updated_at {
                if let Some(object) = row.as_object_mut() {
                    object.insert("status".to_string(), serde_json::json!(status));
                    object.insert("active".to_string(), serde_json::json!(active));
                    object.insert("updatedAtMs".to_string(), serde_json::json!(ev.t));
                    object.insert("rawType".to_string(), serde_json::json!(raw_type));
                    object.insert("eventKind".to_string(), serde_json::json!(event_kind));
                    if let Some(parent_subagent_id) = parent_subagent_id {
                        object.insert(
                            "parentSubagentId".to_string(),
                            serde_json::json!(parent_subagent_id),
                        );
                    }
                }
            }
            continue;
        }
        let row = serde_json::json!({
            "id": format!("provider-native:{key}"),
            "kind": "provider-native-subagent",
            "scope": "provider-native",
            "tabId": tab_id,
            "runId": run_id,
            "providerId": provider_id,
            "agentLabel": debug_tab_agent_label(provider_id),
            "status": status,
            "active": active,
            "label": label,
            "subagentId": subagent_id,
            "parentSubagentId": parent_subagent_id,
            "toolCallId": tool_call_id,
            "rawType": raw_type,
            "eventKind": event_kind,
            "nativeVisibility": "observed",
            "updatedAtMs": ev.t,
        });
        row_indexes.insert(key, rows.len());
        rows.push(row);
    }
    rows
}

pub(super) fn debug_provider_token_usage_by_run(
    events: &[RawEvent],
) -> HashMap<String, serde_json::Value> {
    let mut usage = HashMap::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(tab_id) = json_str(&ev.payload, "tabId")
            .or_else(|| debug_asset_event_tab_id(ev))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let Some(run_id) = json_str(&ev.payload, "runId") else {
            continue;
        };
        let nested = ev.payload.get("usage").unwrap_or(&serde_json::Value::Null);
        let input = json_u64_any(&ev.payload, &["inputTokens"])
            .or_else(|| json_u64_any(nested, &["inputTokens", "input_tokens"]));
        let output = json_u64_any(&ev.payload, &["outputTokens"])
            .or_else(|| json_u64_any(nested, &["outputTokens", "output_tokens"]));
        let total = json_u64_any(&ev.payload, &["totalTokens"])
            .or_else(|| json_u64_any(nested, &["totalTokens", "total_tokens"]));
        let reasoning = json_u64_any(nested, &["reasoningTokens", "reasoning_tokens"]);
        let cache_read = json_u64_any(nested, &["cacheReadTokens", "cache_read_tokens"]);
        let cache_write = json_u64_any(nested, &["cacheWriteTokens", "cache_write_tokens"]);
        if input.is_none()
            && output.is_none()
            && total.is_none()
            && reasoning.is_none()
            && cache_read.is_none()
            && cache_write.is_none()
        {
            continue;
        }
        let entry = usage
            .entry(debug_provider_run_key(tab_id, run_id))
            .or_insert_with(|| serde_json::json!({}));
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        for (key, value) in [
            ("inputTokens", input),
            ("outputTokens", output),
            ("totalTokens", total),
            ("reasoningTokens", reasoning),
            ("cacheReadTokens", cache_read),
            ("cacheWriteTokens", cache_write),
        ] {
            if let Some(value) = value {
                let current = object.get(key).and_then(|item| item.as_u64()).unwrap_or(0);
                object.insert(key.to_string(), serde_json::json!(current.max(value)));
            }
        }
        object.insert("updatedAtMs".to_string(), serde_json::json!(ev.t));
    }
    usage
}

#[derive(Default)]
struct DebugProviderRunMetrics {
    first_response_at_ms: Option<i64>,
    first_text_at_ms: Option<i64>,
    first_action_at_ms: Option<i64>,
    first_successful_action_at_ms: Option<i64>,
    tool_calls: HashSet<String>,
    successful_tools: HashSet<String>,
    failed_tools: HashSet<String>,
    subagents: HashSet<String>,
    lineage_linked_events: u64,
}

pub(super) fn debug_provider_run_metrics_by_run(
    events: &[RawEvent],
) -> HashMap<String, serde_json::Value> {
    let mut metrics = HashMap::<String, DebugProviderRunMetrics>::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(tab_id) = json_str(&ev.payload, "tabId")
            .or_else(|| debug_asset_event_tab_id(ev))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let Some(run_id) = json_str(&ev.payload, "runId") else {
            continue;
        };
        let kind = json_str(&ev.payload, "kind").unwrap_or("");
        let status = json_str(&ev.payload, "status").unwrap_or("");
        let is_text = matches!(kind, "text" | "textDelta")
            && json_str(&ev.payload, "text").is_some_and(|text| !text.is_empty());
        let is_action = matches!(
            kind,
            "tool" | "fileChange" | "command" | "mcpTool" | "subagent"
        );
        let is_response = is_text || is_action || kind == "thinking";
        let metric = metrics
            .entry(debug_provider_run_key(tab_id, run_id))
            .or_default();
        if is_response {
            record_first_timestamp(&mut metric.first_response_at_ms, ev.t);
        }
        if is_text {
            record_first_timestamp(&mut metric.first_text_at_ms, ev.t);
        }
        if !is_action {
            continue;
        }
        record_first_timestamp(&mut metric.first_action_at_ms, ev.t);
        let event_id = json_str(&ev.payload, "eventId").unwrap_or("");
        let tool_key = json_str(&ev.payload, "toolCallId")
            .or_else(|| json_str(&ev.payload, "itemId"))
            .or_else(|| json_str(&ev.payload, "subagentId"))
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{kind}:{}:{event_id}", ev.t));
        metric.tool_calls.insert(tool_key.clone());
        if matches!(status, "completed") {
            metric.successful_tools.insert(tool_key.clone());
            record_first_timestamp(&mut metric.first_successful_action_at_ms, ev.t);
        } else if matches!(status, "failed" | "aborted") {
            metric.failed_tools.insert(tool_key.clone());
        }
        if kind == "subagent" {
            metric.subagents.insert(
                json_str(&ev.payload, "subagentId")
                    .unwrap_or(&tool_key)
                    .to_string(),
            );
        }
        if json_str(&ev.payload, "parentItemId").is_some()
            || json_str(&ev.payload, "parentSubagentId").is_some()
        {
            metric.lineage_linked_events = metric.lineage_linked_events.saturating_add(1);
        }
    }

    metrics
        .into_iter()
        .map(|(key, metric)| {
            (
                key,
                serde_json::json!({
                    "firstResponseAtMs": metric.first_response_at_ms,
                    "firstTextAtMs": metric.first_text_at_ms,
                    "firstActionAtMs": metric.first_action_at_ms,
                    "firstSuccessfulActionAtMs": metric.first_successful_action_at_ms,
                    "toolCallCount": metric.tool_calls.len(),
                    "toolSuccessCount": metric.successful_tools.len(),
                    "toolFailureCount": metric.failed_tools.len(),
                    "subagentCount": metric.subagents.len(),
                    "lineageLinkedEventCount": metric.lineage_linked_events,
                }),
            )
        })
        .collect()
}

fn debug_provider_run_metrics_for_snapshot(
    run: &crate::provider_sessions::ProviderRunSnapshot,
    observed: Option<&serde_json::Value>,
) -> serde_json::Value {
    let observed = observed.cloned().unwrap_or_else(|| serde_json::json!({}));
    let first_response = observed
        .get("firstResponseAtMs")
        .and_then(|value| value.as_i64());
    let first_text = observed
        .get("firstTextAtMs")
        .and_then(|value| value.as_i64());
    let first_action = observed
        .get("firstActionAtMs")
        .and_then(|value| value.as_i64());
    let first_success = observed
        .get("firstSuccessfulActionAtMs")
        .and_then(|value| value.as_i64());
    serde_json::json!({
        "firstResponseAtMs": first_response,
        "firstTextAtMs": first_text,
        "firstActionAtMs": first_action,
        "firstSuccessfulActionAtMs": first_success,
        "timeToFirstResponseMs": first_response.map(|value| value.saturating_sub(run.started_at_ms)),
        "timeToFirstTextMs": first_text.map(|value| value.saturating_sub(run.started_at_ms)),
        "timeToFirstActionMs": first_action.map(|value| value.saturating_sub(run.started_at_ms)),
        "timeToFirstSuccessfulActionMs": first_success.map(|value| value.saturating_sub(run.started_at_ms)),
        "toolCallCount": observed.get("toolCallCount").and_then(|value| value.as_u64()).unwrap_or(0),
        "toolSuccessCount": observed.get("toolSuccessCount").and_then(|value| value.as_u64()).unwrap_or(0),
        "toolFailureCount": observed.get("toolFailureCount").and_then(|value| value.as_u64()).unwrap_or(0),
        "subagentCount": observed.get("subagentCount").and_then(|value| value.as_u64()).unwrap_or(0),
        "lineageLinkedEventCount": observed.get("lineageLinkedEventCount").and_then(|value| value.as_u64()).unwrap_or(0),
    })
}

fn record_first_timestamp(slot: &mut Option<i64>, value: i64) {
    *slot = Some(slot.map_or(value, |current| current.min(value)));
}

fn json_u64_any(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(|item| item.as_u64()))
}

pub(super) fn debug_provider_run_key(tab_id: &str, run_id: &str) -> String {
    format!("{tab_id}:{run_id}")
}

pub(super) fn debug_agent_run_status_is_active(status: &str) -> bool {
    matches!(status, "running" | "starting" | "aborting")
}

pub(super) fn debug_provider_phase_status(
    phase: &crate::provider_sessions::ProviderRunPhase,
) -> &'static str {
    match phase {
        crate::provider_sessions::ProviderRunPhase::Starting => "starting",
        crate::provider_sessions::ProviderRunPhase::Streaming => "running",
        crate::provider_sessions::ProviderRunPhase::Completed => "finished",
        crate::provider_sessions::ProviderRunPhase::Failed => "failed",
        crate::provider_sessions::ProviderRunPhase::Aborted => "aborted",
    }
}

pub(super) fn provider_execution_transport_label(
    transport: &crate::provider_adapters::ProviderExecutionTransport,
) -> &'static str {
    match transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "local",
        crate::provider_adapters::ProviderExecutionTransport::Wsl => "wsl",
        crate::provider_adapters::ProviderExecutionTransport::Ssh => "ssh",
    }
}

pub(super) fn debug_agent_run_updated_at(row: &serde_json::Value) -> i64 {
    row.get("updatedAtMs")
        .and_then(|value| value.as_i64())
        .or_else(|| row.get("startedAtMs").and_then(|value| value.as_i64()))
        .unwrap_or(0)
}

pub(super) fn debug_tab_report_row(
    open: Option<&UiOpenTabContext>,
    info: Option<&serde_json::Value>,
    active_tab_id: Option<&str>,
) -> serde_json::Value {
    let tab_id = open
        .map(|tab| tab.tab_id.as_str())
        .or_else(|| info.and_then(|value| json_str(value, "tabId")))
        .unwrap_or("unknown");
    let provider_id = info.and_then(|value| json_str(value, "providerId"));
    let session_kind = info
        .and_then(|value| json_str(value, "sessionKind"))
        .unwrap_or_else(|| {
            if provider_id.is_some() {
                "provider"
            } else {
                "ui"
            }
        });
    let agent_id = provider_id
        .or_else(|| {
            open.and_then(|tab| {
                tab.agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        })
        .or_else(|| {
            if session_kind == "grok"
                || info
                    .and_then(|value| value.get("hasSession"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                Some("grok")
            } else {
                None
            }
        })
        .unwrap_or("unselected");
    let status = debug_tab_status(open, info);
    let phase = info.and_then(|value| json_str(value, "providerPhase"));
    let cwd = info
        .and_then(|value| json_str(value, "cwd"))
        .map(str::to_string)
        .or_else(|| open.and_then(|tab| tab.cwd.clone()));
    let transport = debug_tab_transport(open, info);
    let surface = serde_json::json!({
        "transport": transport,
        "cwd": cwd,
        "connectionId": open.and_then(|tab| tab.connection_id.clone()),
        "connectionLabel": open.and_then(|tab| tab.connection_label.clone()),
        "wslDistro": info.and_then(|value| json_str(value, "wslDistro")).map(str::to_string),
        "sshHost": info.and_then(|value| json_str(value, "sshHost")).map(str::to_string),
        "sshPort": info.and_then(|value| value.get("sshPort")).and_then(|value| value.as_u64()),
    });

    serde_json::json!({
        "tabId": tab_id,
        "title": open.and_then(|tab| tab.title.clone()),
        "isFocused": active_tab_id.is_some_and(|active| active == tab_id),
        "agentId": agent_id,
        "agentLabel": debug_tab_agent_label(agent_id),
        "sessionKind": session_kind,
        "status": status,
        "phase": phase,
        "surface": surface,
        "sessionId": info
            .and_then(|value| json_str(value, "sessionId"))
            .map(str::to_string)
            .or_else(|| open.and_then(|tab| tab.session_id.clone())),
        "providerRunId": info.and_then(|value| json_str(value, "providerRunId")).map(str::to_string),
        "projectId": open.and_then(|tab| tab.project_id.clone()),
        "branchName": open.and_then(|tab| tab.branch_name.clone()),
        "isSending": open.and_then(|tab| tab.is_sending).unwrap_or(false),
    })
}

pub(super) fn debug_tab_status(
    open: Option<&UiOpenTabContext>,
    info: Option<&serde_json::Value>,
) -> String {
    if let Some(phase) = info.and_then(|value| json_str(value, "providerPhase")) {
        return match phase {
            "starting" | "streaming" => "running".to_string(),
            "completed" => "finished".to_string(),
            "failed" => "failed".to_string(),
            "aborted" => "aborted".to_string(),
            other => other.to_string(),
        };
    }
    if open.and_then(|tab| tab.is_sending).unwrap_or(false) {
        return "running".to_string();
    }
    match open
        .and_then(|tab| tab.status.as_deref())
        .map(str::trim)
        .unwrap_or("")
    {
        "Starting" => "starting".to_string(),
        "Connected" => "connected".to_string(),
        "Aborting" => "aborting".to_string(),
        "Error" => "failed".to_string(),
        "Idle" | "" => {
            if info
                .and_then(|value| value.get("hasSession"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                "connected".to_string()
            } else {
                "idle".to_string()
            }
        }
        other => other.to_ascii_lowercase(),
    }
}

pub(super) fn debug_tab_transport(
    open: Option<&UiOpenTabContext>,
    info: Option<&serde_json::Value>,
) -> String {
    if let Some(transport) = info
        .and_then(|value| json_str(value, "transport"))
        .filter(|value| !value.trim().is_empty())
    {
        return transport.to_string();
    }
    if info
        .and_then(|value| value.get("isSsh"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return "ssh".to_string();
    }
    if info
        .and_then(|value| value.get("isWsl"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return "wsl".to_string();
    }
    open.and_then(|tab| tab.connection_transport.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string()
}

pub(super) fn debug_tab_agent_label(agent_id: &str) -> &'static str {
    match agent_id {
        "grok" => "Grok",
        "codex-cli" => "Codex CLI",
        "claude-code" => "Claude Code",
        "antigravity-cli" => "Antigravity CLI",
        "unselected" => "Unselected",
        _ => "Agent",
    }
}

pub(super) fn json_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

#[derive(Deserialize)]
pub(super) struct SessionAssetsQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub(super) fn debug_asset_source_tab_from_info(
    tab_id: String,
    info: &serde_json::Value,
) -> DebugAssetSourceTab {
    let session_id = info
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let cwd = info.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_wsl = info.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let transport = if is_ssh {
        Some("ssh".to_string())
    } else if is_wsl {
        Some("wsl".to_string())
    } else {
        Some("local".to_string())
    };
    let connection_label = info
        .get("sshHost")
        .and_then(|v| v.as_str())
        .or_else(|| info.get("wslDistro").and_then(|v| v.as_str()))
        .map(str::to_string)
        .or_else(|| Some("Local".to_string()));
    DebugAssetSourceTab {
        tab_id,
        session_id,
        cwd,
        transport,
        connection_label,
    }
}

pub(super) async fn state_session_assets(
    State(s): State<ApiState>,
    Query(q): Query<SessionAssetsQuery>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_ids = registry.list_tabs().await;
    let mut tabs_by_id: HashMap<String, DebugAssetSourceTab> = HashMap::new();
    for tab_id in tab_ids {
        if let Some(want) = q.tab_id.as_deref() {
            if tab_id != want {
                continue;
            }
        }
        let Some(sess_arc) = registry.get_existing(&tab_id).await else {
            continue;
        };
        let sess = sess_arc.lock().await;
        let info = sess.get_debug_session_info();
        drop(sess);
        tabs_by_id.insert(
            tab_id.clone(),
            debug_asset_source_tab_from_info(tab_id, &info),
        );
    }
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    for run in provider_registry.runs_all_tabs() {
        if let Some(want) = q.tab_id.as_deref() {
            if run.tab_id != want {
                continue;
            }
        }
        tabs_by_id
            .entry(run.tab_id.clone())
            .or_insert_with(|| debug_asset_source_tab_from_provider_run(&run));
    }
    let tabs: Vec<DebugAssetSourceTab> = tabs_by_id.into_values().collect();
    let events = s.hub().recent(RING_CAPACITY);
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    Json(debug_collect_session_assets_for_tabs(
        &events,
        &tabs,
        q.tab_id.as_deref(),
        limit,
    ))
    .into_response()
}

/// /state/subagents query params. `maxAgeMs` scopes
/// the rail-pane window. Default 30 min — see handler doc-comment.
#[derive(Deserialize)]
pub(super) struct SubagentsQuery {
    #[serde(rename = "maxAgeMs", default)]
    max_age_ms: Option<i64>,
}

pub(super) async fn state_subagents(
    State(_s): State<ApiState>,
    Query(q): Query<SubagentsQuery>,
) -> impl IntoResponse {
    // Read from cross-process `subagents.db`, NOT the in-memory
    // `subagent::REGISTRY`. Main shellX (this process) and the
    // `--mcp-server` child where subagents actually spawn are separate
    // processes with separate address spaces. The in-memory registry
    // here is permanently empty because no `Agent` tool call ever runs
    // in THIS process. The db is the shared store.
    // Accept `?maxAgeMs=` to scope the rail-pane window. Default 30
    // min — a 24h window makes the rail-pane render with 70+ entries.
    // 30 min keeps "what's happening NOW" visible while still showing
    // the just-finished agent rows users want to inspect
    // post-completion.
    let max_age_ms = q.max_age_ms.unwrap_or(30 * 60 * 1000);
    let rows = match crate::host_subagents::list_recent_read_only(Some(max_age_ms)) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("subagents db read failed: {}", e),
            )
                .into_response();
        }
    };
    let count = rows.len();
    Json(serde_json::json!({
        "subagents": rows,
        "count": count,
    }))
    .into_response()
}
