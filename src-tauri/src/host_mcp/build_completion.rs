use super::*;

pub(super) struct BuildAgentCompletionWatcher {
    pub(super) ctx: Arc<HostMcpContext>,
    pub(super) tab: String,
    pub(super) subagent_id: String,
    pub(super) persona: String,
    pub(super) task: String,
    pub(super) meta: BuildAgentReceiptMeta,
    pub(super) cwd: Option<String>,
}

pub(super) async fn run_build_agent_completion_watcher(args: BuildAgentCompletionWatcher) {
    let BuildAgentCompletionWatcher {
        ctx,
        tab,
        subagent_id,
        persona,
        task,
        meta,
        cwd,
    } = args;
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    loop {
        interval.tick().await;
        let Some((_orch, _tab, state)) = active_build_run_for_mcp(&ctx, Some(&tab), "Agent").await
        else {
            break;
        };
        if !build_agent_completion_watcher_should_track(state.status) {
            break;
        }

        let status_value = match crate::subagent::status(&subagent_id).await {
            Ok(value) => value,
            Err(e) => {
                tracing::debug!(
                    "host_mcp: build agent watcher stopping; status unavailable subagent={} err={}",
                    subagent_id,
                    e
                );
                break;
            }
        };
        if status_value
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            == "running"
        {
            continue;
        }

        let output_value = crate::subagent::output(&subagent_id, false)
            .await
            .unwrap_or(status_value);
        record_build_agent_completed_receipt(
            &output_value,
            &persona,
            &task,
            meta,
            cwd.as_deref(),
            &ctx,
            Some(&tab),
        )
        .await;
        if let Some(app_handle) = ctx.app_handle.as_ref() {
            crate::acp::maybe_inject_build_continuation_for_tab(app_handle, &tab, "end_turn").await;
        }
        break;
    }
}

pub(super) fn redacted_task_preview(task: &str, max_chars: usize) -> String {
    let preview: String = task.chars().take(max_chars).collect();
    if redact_if_credential_pattern(&preview) {
        "<redacted: credential-shaped substring>".to_string()
    } else {
        preview
    }
}

pub(super) fn build_gate_agent_task(persona: &str, task: &str) -> String {
    let suffix = match persona {
        "reviewer" => {
            "\n\nshellX Build gate output requirements: end with a compact review report using these headings: `## Review`, `### Summary`, and either at least one `### Finding N` with `- Severity:` plus file:line evidence, or `### Positive observations` when there are no findings. Do not answer only `OK`."
        }
        "verifier" => {
            "\n\nshellX Build gate output requirements: end with a compact verification report using these headings: `## Verification`, `## Behavior Evidence`, and `## Gaps`. Include PASS or FAIL beside every command or smoke check. Do not answer only `OK`."
        }
        _ => return task.to_string(),
    };
    if task.contains("shellX Build gate output requirements") {
        task.to_string()
    } else {
        format!("{}{}", task, suffix)
    }
}

const MIN_BUILD_GATE_STDOUT_CHARS: usize = 80;

pub(super) fn build_gate_output_evidence(persona: &str, stdout: &str) -> Value {
    let stdout_chars = stdout.chars().count();
    let lower = stdout.to_ascii_lowercase();
    let markers: Vec<&'static str> = match persona {
        "reviewer" => [
            ("review", "## review"),
            ("summary", "### summary"),
            ("finding", "### finding"),
            ("severity", "- severity:"),
            ("positive observations", "### positive observations"),
        ]
        .into_iter()
        .filter_map(|(label, needle)| lower.contains(needle).then_some(label))
        .collect(),
        "verifier" => [
            ("verification", "## verification"),
            ("behavior evidence", "## behavior evidence"),
            ("gaps", "## gaps"),
            ("pass", "pass"),
            ("fail", "fail"),
        ]
        .into_iter()
        .filter_map(|(label, needle)| lower.contains(needle).then_some(label))
        .collect(),
        _ => Vec::new(),
    };
    let accepted = stdout_chars >= MIN_BUILD_GATE_STDOUT_CHARS && markers.len() >= 2;
    json!({
        "accepted": accepted,
        "reason": if accepted {
            "gate output matched expected report shape"
        } else if stdout_chars < MIN_BUILD_GATE_STDOUT_CHARS {
            "gate output too short"
        } else {
            "gate output missing required report markers"
        },
        "matchedMarkers": markers,
        "stdoutChars": stdout_chars,
    })
}

pub(super) async fn record_build_agent_completed_receipt(
    value: &Value,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if status == "running" {
        return;
    }
    let preview = redacted_task_preview(task, 180);
    let subagent_id = value
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !register_build_agent_completion(ctx, tab_id, subagent_id).await {
        return;
    }
    let receipt_key =
        build_agent_receipt_key_for_current_run(ctx, tab_id, "Agent", subagent_id).await;
    let receipt_meta = match receipt_key.as_deref() {
        Some(key) => remembered_build_agent_receipt_meta(key)
            .await
            .unwrap_or(meta),
        None => meta,
    };
    let elapsed_ms = value.get("elapsed_ms").and_then(|v| v.as_u64());
    let mut data_map = serde_json::Map::new();
    data_map.insert("persona".into(), Value::String(persona.to_string()));
    data_map.insert("taskPreview".into(), Value::String(preview.clone()));
    data_map.insert("subagentId".into(), Value::String(subagent_id.to_string()));
    data_map.insert("status".into(), Value::String(status.to_string()));
    data_map.insert(
        "exitCode".into(),
        value.get("exit_code").cloned().unwrap_or(Value::Null),
    );
    data_map.insert(
        "elapsedMs".into(),
        elapsed_ms
            .map(|ms| Value::Number(serde_json::Number::from(ms)))
            .unwrap_or(Value::Null),
    );
    data_map.insert(
        "stdoutChars".into(),
        Value::Number(serde_json::Number::from(
            value
                .get("stdout")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count())
                .unwrap_or(0),
        )),
    );
    data_map.insert(
        "stderrTailChars".into(),
        Value::Number(serde_json::Number::from(
            value
                .get("stderr_tail")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count())
                .unwrap_or(0),
        )),
    );
    if build_agent_gate_kind_for_persona(persona).is_some() {
        let stdout = value.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
        data_map.insert(
            "gateEvidence".into(),
            build_gate_output_evidence(persona, stdout),
        );
    }
    data_map.insert(
        "cwd".into(),
        cwd.map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    );
    insert_build_agent_receipt_timing(&mut data_map, receipt_meta, Some(value));
    let data = Value::Object(data_map);
    append_build_host_receipt(
        ctx,
        tab_id,
        "Agent",
        BuildHostReceipt {
            kind: BuildReceiptKind::AgentCompleted,
            actor: "shellx-host-mcp",
            summary: format!("{} Agent finished with status {}", persona, status),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: data.clone(),
        },
    )
    .await;
    if let Some(key) = receipt_key {
        forget_build_agent_receipt_meta(&key).await;
    }
    if status != "completed" {
        return;
    }
    checkpoint_build_agent_completion(persona, task, cwd, ctx, tab_id).await;
    let gate_kind = build_agent_gate_kind_for_persona(persona);
    if let Some(kind) = gate_kind {
        append_build_host_receipt(
            ctx,
            tab_id,
            "Agent",
            BuildHostReceipt {
                kind,
                actor: persona,
                summary: format!("{} Agent completed successfully", persona),
                confidence: BuildReceiptConfidence::TrustedHost,
                data,
            },
        )
        .await;
    }
}

pub(super) async fn register_build_agent_completion(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    subagent_id: &str,
) -> bool {
    if subagent_id.is_empty() {
        return true;
    }
    let Some((_orch, _tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await else {
        return true;
    };
    let key = build_agent_watcher_key(&state.run_id, subagent_id);
    try_register_build_agent_completion(key).await
}

pub(super) async fn record_build_agent_receipt(
    event: BuildAgentReceiptEvent<'_>,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let preview = redacted_task_preview(task, 180);
    match event {
        BuildAgentReceiptEvent::Started(value) => {
            let subagent_id = value
                .and_then(|v| v.get("subagent_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(key) =
                build_agent_receipt_key_for_current_run(ctx, tab_id, "Agent", subagent_id).await
            {
                remember_build_agent_receipt_meta(key, meta).await;
            }
            let status = value
                .and_then(|v| v.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or("running");
            append_build_host_receipt(
                ctx,
                tab_id,
                "Agent",
                BuildHostReceipt {
                    kind: BuildReceiptKind::AgentStarted,
                    actor: "shellx-host-mcp",
                    summary: format!("{} Agent started: {}", persona, preview),
                    confidence: BuildReceiptConfidence::TrustedHost,
                    data: {
                        let mut map = serde_json::Map::new();
                        map.insert("persona".into(), Value::String(persona.to_string()));
                        map.insert("taskPreview".into(), Value::String(preview));
                        map.insert("subagentId".into(), Value::String(subagent_id.to_string()));
                        map.insert("status".into(), Value::String(status.to_string()));
                        map.insert(
                            "cwd".into(),
                            cwd.map(|s| Value::String(s.to_string()))
                                .unwrap_or(Value::Null),
                        );
                        insert_build_agent_receipt_timing(&mut map, meta, value);
                        Value::Object(map)
                    },
                },
            )
            .await;
            maybe_start_build_agent_completion_watcher(
                value, persona, task, meta, cwd, ctx, tab_id,
            )
            .await;
        }
        BuildAgentReceiptEvent::Completed(value) => {
            record_build_agent_completed_receipt(value, persona, task, meta, cwd, ctx, tab_id)
                .await;
        }
    }
}

pub(super) async fn checkpoint_build_agent_completion(
    persona: &str,
    task: &str,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    let Some(label) = build_agent_checkpoint_label_for_persona(persona) else {
        return;
    };
    let Some(tab) = tab_id else {
        return;
    };
    let Some(cwd) = cwd.or_else(|| ctx.cwd.to_str()) else {
        return;
    };
    match create_build_agent_checkpoint_via_session_git(ctx, tab, Some(cwd), label).await {
        Ok(data) => {
            tracing::info!(
                "host_mcp: build agent checkpoint created persona={} tab={} label={} checkpoint={:?}",
                persona,
                tab,
                label,
                data.get("id").or_else(|| data.get("checkpointId"))
            );
        }
        Err(e) => {
            tracing::warn!(
                "host_mcp: build agent checkpoint failed persona={} tab={} err={}",
                persona,
                tab,
                e
            );
            let agent_code_change =
                build_agent_checkpoint_fallback_assume_code_change(persona, task);
            append_build_host_receipt(
                ctx,
                Some(tab),
                "Agent",
                BuildHostReceipt {
                    kind: crate::build_types::BuildReceiptKind::CheckpointCreated,
                    actor: "shellx-git",
                    summary: format!(
                        "Git checkpoint unavailable after {} Agent completion: {}",
                        persona, e
                    ),
                    confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
                    data: json!({
                        "checkpointId": format!("{}-checkpoint-unavailable", label),
                        "checkpointUnavailable": true,
                        "checkpointUnavailableReason": e,
                        "agentCodeChange": agent_code_change,
                        "cwd": cwd,
                        "label": label,
                    }),
                },
            )
            .await;
        }
    }
}

pub(super) async fn create_build_agent_checkpoint_via_session_git(
    ctx: &Arc<HostMcpContext>,
    tab: &str,
    cwd: Option<&str>,
    label: &str,
) -> Result<Value, String> {
    let cwd = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let label = Some(label.to_string());
    let snapshot = if let Some(app_handle) = &ctx.app_handle {
        use tauri::Manager as _;
        let registry = app_handle
            .try_state::<Arc<crate::acp::SessionRegistry>>()
            .ok_or_else(|| {
                "build agent checkpoint: SessionRegistry is not registered".to_string()
            })?;
        let build_orch = app_handle
            .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .ok_or_else(|| {
                "build agent checkpoint: BuildOrchestrator is not registered".to_string()
            })?;
        let provider_context = app_handle
            .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            .and_then(|provider_registry| {
                crate::session_git::git_provider_context_for_tab(provider_registry.inner(), tab)
            });
        serde_json::to_value(
            crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
                registry.inner().clone(),
                build_orch.inner().clone(),
                Some(tab.to_string()),
                cwd,
                label,
                provider_context,
            )
            .await?,
        )
        .map_err(|e| format!("build agent checkpoint response serialize: {}", e))?
    } else {
        post_build_checkpoint_to_debug_api(tab, cwd, label).await?
    };
    checkpoint_snapshot_to_data(snapshot)
}

pub(super) fn checkpoint_snapshot_to_data(snapshot: Value) -> Result<Value, String> {
    if snapshot.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let message = snapshot
            .get("lastError")
            .or_else(|| snapshot.get("last_error"))
            .and_then(|value| value.as_str())
            .unwrap_or("checkpoint creation failed");
        return Err(message.to_string());
    }
    snapshot
        .get("checkpoint")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| "checkpoint creation returned ok=true without checkpoint data".to_string())
}

pub(super) fn build_agent_checkpoint_label_for_persona(persona: &str) -> Option<&'static str> {
    match persona {
        "implementer" => Some("agent-implementer-complete"),
        "test-writer" => Some("agent-test-writer-complete"),
        "release-manager" => Some("agent-release-manager-complete"),
        _ => None,
    }
}

pub(super) fn build_agent_checkpoint_fallback_assume_code_change(
    persona: &str,
    task: &str,
) -> bool {
    if matches!(persona, "implementer" | "release-manager") {
        return true;
    }
    if persona != "test-writer" {
        return false;
    }
    let lower = task.to_ascii_lowercase();
    if [
        "analysis only",
        "without changing files",
        "without modifying files",
        "do not change files",
        "do not modify files",
        "do not write files",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return false;
    }

    let write_intent = [
        "create ",
        "add ",
        "modify ",
        "edit ",
        "update ",
        "implement ",
        "generate ",
        "save ",
        "patch ",
        "write ",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let explicit_test_file_target = [
        ".test.",
        ".spec.",
        "__tests__",
        "/tests/",
        "\\tests\\",
        "test file",
        "spec file",
        "test suite",
        "test script",
        "coverage file",
    ]
    .iter()
    .any(|needle| lower.contains(needle));

    write_intent && explicit_test_file_target
}
