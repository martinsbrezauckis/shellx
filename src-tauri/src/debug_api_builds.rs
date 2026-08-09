use super::*;

#[derive(Deserialize)]
pub(super) struct BuildStartBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    objective: String,
    cwd: Option<String>,
    /// Guarded installed-release fixture state. This creates a real local
    /// Build run and scratchboard inside one disposable ShellX-home child;
    /// it is unavailable on normal app instances.
    #[serde(rename = "releaseTestState", default)]
    release_test_state: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct BuildTabBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    inject: Option<bool>,
    /// Remove one exact isolated release-test Build runtime and persisted
    /// ledger instead of retaining normal product history.
    #[serde(rename = "releaseTestClearState", default)]
    release_test_clear_state: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuildReceiptBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    kind: crate::build_types::BuildReceiptKind,
    summary: String,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    confidence: Option<crate::build_types::BuildReceiptConfidence>,
    #[serde(default)]
    data: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuildOperatorNoteBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    text: String,
}

#[derive(Deserialize, Default)]
pub(super) struct BuildReceiptsQuery {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    limit: Option<usize>,
}

pub(super) async fn build_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildStartBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    if body.objective.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "objective: must be non-empty").into_response();
    }
    let release_test_state = match body.release_test_state.as_deref() {
        None => None,
        Some("awaiting-approval") => Some("awaiting-approval"),
        Some("active") => Some("active"),
        Some("paused") => Some("paused"),
        Some("blocked-recheckable") => Some("blocked-recheckable"),
        Some(_) => return (
            StatusCode::BAD_REQUEST,
            "releaseTestState: expected awaiting-approval, active, paused, or blocked-recheckable",
        )
            .into_response(),
    };
    if release_test_state.is_some() && !crate::isolated_test_instance_requested() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "release_test_route_unavailable",
                "message": "release-test Build fixture state is unavailable outside an isolated test instance",
            })),
        )
            .into_response();
    }
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let cwd = if let Some(c) = body.cwd.filter(|c| !c.trim().is_empty()) {
        std::path::PathBuf::from(c)
    } else if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        guard
            .get_cwd_for_restart()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    if release_test_state.is_some() {
        if let Err(error) = validate_release_test_build_namespace(&tab_id, &cwd) {
            return (StatusCode::BAD_REQUEST, error).into_response();
        }
    }
    let (transport_kind, ssh_config) = if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        (
            guard.transport_kind().to_string(),
            guard.ssh_config().cloned(),
        )
    } else {
        ("local".to_string(), None)
    };
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch
        .start_run_with_transport_context(
            &tab_id,
            &body.objective,
            &cwd,
            &transport_kind,
            ssh_config,
        )
        .await
    {
        Ok(mut state) => {
            if let Some(target) = release_test_state {
                match prepare_release_test_build_state(&orch, &tab_id, target).await {
                    Ok(prepared) => state = prepared,
                    Err(error) => {
                        let _ = orch.release_test_clear_tab(&tab_id).await;
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "error": "release_test_build_fixture_failed",
                                "message": error,
                            })),
                        )
                            .into_response();
                    }
                }
            }
            let kickoff_prompt =
                crate::build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
                    &body.objective,
                    &state.scratchboard_path,
                );
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "state": state,
                "kickoffPrompt": kickoff_prompt,
                "releaseTestState": release_test_state,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn build_stop_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    if body.release_test_clear_state {
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test Build cleanup is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
        if !release_test_build_tab(&tab_id) {
            return (
                StatusCode::BAD_REQUEST,
                "releaseTestClearState: tabId must name an owned release Build fixture",
            )
                .into_response();
        }
        let provider_registry = s
            .app
            .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            .inner()
            .clone();
        if let Err(error) = provider_registry.release_test_forget_completed_tab(&tab_id) {
            return (StatusCode::CONFLICT, error).into_response();
        }
        return match orch.release_test_clear_tab(&tab_id).await {
            Ok(()) => Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "stopped": true,
                "active": false,
                "releaseTestCleared": true,
            }))
            .into_response(),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
        };
    }
    let summary = body
        .summary
        .unwrap_or_else(|| "Stopped via debug API".to_string());
    let build_run_id = orch.get_state(&tab_id).await.map(|state| state.run_id);
    let in_flight_agent_ids = orch.in_flight_agent_ids(&tab_id).await.unwrap_or_default();
    match orch.halt(&tab_id, &summary).await {
        Ok(stopped) => {
            let aborted_tab_tasks = crate::tab_tasks::abort_tab(&tab_id);
            let aborted_agent_watchers = match build_run_id.as_deref() {
                Some(run_id) => crate::host_mcp::abort_build_agent_watchers_for_run(run_id).await,
                None => 0,
            };
            let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
            let (prompt_cancelled, prompt_cancel_error) =
                match crate::acp::cancel_prompt_only_for_existing_tab(
                    registry.inner().as_ref(),
                    &tab_id,
                )
                .await
                {
                    Ok(cancelled) => (cancelled, None),
                    Err(e) => {
                        warn!(
                            "/build/stop: prompt cancel for tab '{}' failed: {}",
                            tab_id, e
                        );
                        (false, Some(e))
                    }
                };
            let mut killed_agent_subagents = Vec::new();
            let mut agent_kill_errors = Vec::new();
            for subagent_id in in_flight_agent_ids {
                match crate::subagent::kill(&subagent_id, true).await {
                    Ok(value) => {
                        killed_agent_subagents.push(serde_json::json!({
                            "subagentId": subagent_id,
                            "source": "inProcessRegistry",
                            "result": value,
                        }));
                    }
                    Err(in_process_error) => {
                        match crate::host_subagents::force_kill_running(&subagent_id) {
                            Ok(Some(value)) => {
                                killed_agent_subagents.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "source": "subagentsDb",
                                    "inProcessError": in_process_error,
                                    "result": value,
                                }));
                            }
                            Ok(None) => {
                                killed_agent_subagents.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "source": "alreadyGone",
                                    "inProcessError": in_process_error,
                                    "result": {
                                        "killed": false,
                                        "wasRunning": false,
                                        "note": "subagent id not found in subagents.db",
                                    },
                                }));
                            }
                            Err(db_error) => {
                                agent_kill_errors.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "inProcessError": in_process_error,
                                    "dbError": db_error,
                                }));
                            }
                        }
                    }
                }
            }
            let process_registry = s
                .app
                .state::<std::sync::Arc<crate::process_registry::ProcessRegistry>>();
            let host_mcp_tasks = process_registry
                .running_task_ids_for_tab_source(
                    &tab_id,
                    crate::process_registry::ProcessSource::HostMcp,
                )
                .await;
            let mut killed_host_mcp_tasks = Vec::new();
            let mut kill_errors = Vec::new();
            for task_id in host_mcp_tasks {
                match process_registry.signal_tree(&task_id, "SIGKILL").await {
                    Ok(()) => killed_host_mcp_tasks.push(task_id),
                    Err(e) => kill_errors.push(serde_json::json!({
                        "taskId": task_id,
                        "error": e,
                    })),
                }
            }
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "stopped": stopped,
                "active": false,
                "promptCancelled": prompt_cancelled,
                "promptCancelError": prompt_cancel_error,
                "killedHostMcpTasks": killed_host_mcp_tasks,
                "killErrors": kill_errors,
                "killedAgentSubagents": killed_agent_subagents,
                "agentKillErrors": agent_kill_errors,
                "abortedAgentWatchers": aborted_agent_watchers,
                "abortedTabTasks": aborted_tab_tasks,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn release_test_build_tab(tab_id: &str) -> bool {
    tab_id.starts_with("release-build-run-")
        && tab_id.len() <= 96
        && tab_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_release_test_build_namespace(
    tab_id: &str,
    cwd: &std::path::Path,
) -> Result<(), String> {
    if !release_test_build_tab(tab_id) {
        return Err("releaseTestState: tabId must name an owned release Build fixture".into());
    }
    let name = cwd
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "release Build cwd has no valid final component".to_string())?;
    if !name.starts_with(&format!("{tab_id}-"))
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("release Build cwd is outside its owned namespace".into());
    }
    let metadata = std::fs::symlink_metadata(cwd)
        .map_err(|error| format!("read release Build cwd: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("release Build cwd must be a real directory".into());
    }
    let shellx_home = std::fs::canonicalize(shellx_home()?)
        .map_err(|error| format!("resolve ShellX home: {error}"))?;
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|error| format!("resolve release Build cwd: {error}"))?;
    if cwd.parent() != Some(shellx_home.as_path()) {
        return Err("release Build cwd must be a direct ShellX-home child".into());
    }
    Ok(())
}

async fn prepare_release_test_build_state(
    orch: &crate::build_orchestrator::BuildOrchestrator,
    tab_id: &str,
    target: &str,
) -> Result<crate::build_types::BuildRunState, String> {
    let state = orch
        .get_state(tab_id)
        .await
        .ok_or_else(|| "isolated Build fixture state was not created".to_string())?;
    let plan = format!(
        "# Build: {}\n\nStatus: AWAITING_APPROVAL\n\n## Phase 1 - Exercise lifecycle\n- [ ] Invoke the owned Build Run Cockpit control\n\n## Phase 2 - Review\n- [ ] Reviewer must run an AI slop / wiring audit: unwired UI controls, placeholder/mock code, fake success paths, missing frontend/backend bridges, config/schema drift, and release-debug leaks\n",
        state.objective.trim()
    );
    crate::goal_orchestrator::write_scratchboard_text_for_transport(
        std::path::Path::new(&state.scratchboard_path),
        &plan,
        &state.transport_kind,
        None,
    )
    .await?;
    let awaiting = orch
        .get_state(tab_id)
        .await
        .ok_or_else(|| "isolated Build fixture disappeared after plan write".to_string())?;
    if awaiting.status != crate::build_types::BuildRunStatus::AwaitingApproval {
        return Err("isolated Build fixture did not become approval-ready".into());
    }
    if target == "awaiting-approval" {
        return Ok(awaiting);
    }
    if !orch.approve_plan(tab_id).await? {
        return Err("isolated Build fixture did not enter its approved active state".into());
    }
    if target == "paused" && !orch.pause(tab_id).await? {
        return Err("isolated Build fixture did not enter its paused state".into());
    }
    if target == "blocked-recheckable" {
        let active = orch
            .get_state(tab_id)
            .await
            .ok_or_else(|| "isolated Build fixture disappeared before blocker setup".to_string())?;
        orch.append_receipt(crate::build_types::BuildReceipt {
            receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
            run_id: active.run_id.clone(),
            tab_id: tab_id.to_string(),
            kind: crate::build_types::BuildReceiptKind::BlockerOpened,
            created_at_ms: now_ms() as u64,
            actor: "shellx-release-fixture".into(),
            summary: "Review gate receipt is pending for the isolated fixture".into(),
            confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
            data: serde_json::json!({ "fixtureOnly": true }),
        })
        .await?;
        orch.append_receipt(crate::build_types::BuildReceipt {
            receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
            run_id: active.run_id,
            tab_id: tab_id.to_string(),
            kind: crate::build_types::BuildReceiptKind::ReviewCompleted,
            created_at_ms: now_ms() as u64,
            actor: "shellx-release-fixture".into(),
            summary: "Owned review evidence is now complete".into(),
            confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
            data: serde_json::json!({
                "fixtureOnly": true,
                "gateEvidence": { "accepted": true },
            }),
        })
        .await?;
    }
    let prepared = orch
        .get_state(tab_id)
        .await
        .ok_or_else(|| "isolated Build fixture disappeared after state preparation".to_string())?;
    let expected = match target {
        "active" => crate::build_types::BuildRunStatus::Active,
        "paused" => crate::build_types::BuildRunStatus::Paused,
        "blocked-recheckable" => crate::build_types::BuildRunStatus::Blocked,
        _ => return Err("unsupported isolated Build fixture target".into()),
    };
    if prepared.status != expected {
        return Err(format!(
            "isolated Build fixture reached {:?}, expected {:?}",
            prepared.status, expected
        ));
    }
    Ok(prepared)
}

pub(super) async fn build_pause_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.pause(&tab_id).await {
        Ok(paused) => {
            let aborted_tab_tasks = if paused {
                crate::tab_tasks::abort_kind(
                    &tab_id,
                    crate::tab_tasks::TabTaskKind::BuildResumeInject,
                ) as usize
            } else {
                0
            };
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "paused": paused,
                "abortedTabTasks": aborted_tab_tasks,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn build_resume_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    if registry.get_existing(&tab_id).await.is_none() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "Connect this tab before resuming Build Mode.",
            })),
        )
            .into_response();
    }
    match orch.resume(&tab_id).await {
        Ok(resumed) => {
            if resumed {
                let app = s.app.clone();
                let tab_for_inject = tab_id.clone();
                crate::tab_tasks::spawn_replace(
                    &tab_id,
                    crate::tab_tasks::TabTaskKind::BuildResumeInject,
                    async move {
                        crate::acp::maybe_inject_build_continuation_for_tab(
                            &app,
                            &tab_for_inject,
                            "end_turn",
                        )
                        .await;
                    },
                );
            }
            Json(serde_json::json!({"ok": true, "tabId": tab_id, "resumed": resumed}))
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn build_recheck_blocker_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.recheck_blocker(&tab_id).await {
        Ok(result) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "result": result,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn build_operator_note_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildOperatorNoteBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.add_operator_note(&tab_id, &body.text).await {
        Ok(note) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "note": note,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": e,
            })),
        )
            .into_response(),
    }
}

pub(super) async fn build_approve_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let changed = match orch.approve_plan(&tab_id).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "tabId": tab_id,
                    "approved": false,
                    "injected": false,
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    let mut injected = false;
    if changed && body.inject.unwrap_or(true) {
        let active = orch.get_state(&tab_id).await;
        let objective = active
            .as_ref()
            .map(|st| st.objective.as_str())
            .unwrap_or("(unknown objective)");
        let path = active
            .as_ref()
            .map(|st| st.scratchboard_path.as_str())
            .unwrap_or("the Build Mode scratchboard");
        let prompt = format!(
            "The Build Mode scratchboard plan has been approved.\n\nObjective: {}\n\nScratchboard: {}\n\nBegin executing it now. Use shellX Agent personas when useful, include the AI slop / wiring audit in the reviewer pass, record evidence in the scratchboard, and call build_complete only after required gates are satisfied. Agent task text must be a direct assignment to that subagent; do not ask subagents to dispatch more Agents, poll Agent output, or follow scratchboard manager checklist lines as their own instructions.",
            objective, path
        );
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            let attempt = async {
                let mut sess = sess_arc.lock().await;
                sess.initiate_and_send_prompt(&prompt).await
            };
            injected = matches!(
                tokio::time::timeout(Duration::from_secs(120), attempt).await,
                Ok(Ok(_))
            );
        }
    }
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "approved": changed,
        "injected": injected,
    }))
    .into_response()
}

pub(super) async fn build_reject_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let build_run_id = orch.get_state(&tab_id).await.map(|state| state.run_id);
    match orch.reject_plan(&tab_id).await {
        Ok(rejected) => {
            let aborted_tab_tasks = if rejected {
                crate::tab_tasks::abort_kind(
                    &tab_id,
                    crate::tab_tasks::TabTaskKind::BuildResumeInject,
                ) as usize
            } else {
                0
            };
            let aborted_agent_watchers = if rejected {
                match build_run_id.as_deref() {
                    Some(run_id) => {
                        crate::host_mcp::abort_build_agent_watchers_for_run(run_id).await
                    }
                    None => 0,
                }
            } else {
                0
            };
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "rejected": rejected,
                "abortedAgentWatchers": aborted_agent_watchers,
                "abortedTabTasks": aborted_tab_tasks,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) async fn build_complete_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let summary = body
        .summary
        .unwrap_or_else(|| "Completed via debug API".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let build_run_id = orch.get_state(&tab_id).await.map(|state| state.run_id);
    match orch.validate_complete(&tab_id, &summary).await {
        Ok(()) => {
            let aborted_tab_tasks = crate::tab_tasks::abort_kind(
                &tab_id,
                crate::tab_tasks::TabTaskKind::BuildResumeInject,
            ) as usize;
            let aborted_agent_watchers = match build_run_id.as_deref() {
                Some(run_id) => crate::host_mcp::abort_build_agent_watchers_for_run(run_id).await,
                None => 0,
            };
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "complete": true,
                "abortedAgentWatchers": aborted_agent_watchers,
                "abortedTabTasks": aborted_tab_tasks,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "complete": false,
                "message": e,
            })),
        )
            .into_response(),
    }
}

pub(super) async fn build_receipt_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildReceiptBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let summary = body.summary.trim().to_string();
    if summary.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "summary is required",
            })),
        )
            .into_response();
    }
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let Some(state) = orch.get_state(&tab_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "no active /build run for this tab",
            })),
        )
            .into_response();
    };
    let confidence = build_receipt_http_confidence(body.confidence);
    let receipt = crate::build_types::BuildReceipt {
        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
        run_id: state.run_id,
        tab_id: tab_id.clone(),
        kind: body.kind,
        created_at_ms: now_ms() as u64,
        actor: body.actor.unwrap_or_else(|| "debug-api".to_string()),
        summary,
        confidence,
        data: body.data,
    };
    match orch.append_receipt(receipt.clone()).await {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) fn build_receipt_http_confidence(
    _requested: Option<crate::build_types::BuildReceiptConfidence>,
) -> crate::build_types::BuildReceiptConfidence {
    crate::build_types::BuildReceiptConfidence::ModelDeclared
}

pub(super) async fn build_state_http(
    State(s): State<ApiState>,
    Query(q): Query<GoalStateQuery>,
) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let state = orch.get_state(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "state": state,
    }))
    .into_response()
}

pub(super) async fn build_receipts_http(
    State(s): State<ApiState>,
    Query(q): Query<BuildReceiptsQuery>,
) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.get_receipts(&tab_id).await {
        Ok(receipts) => {
            let total_receipts = receipts.len();
            let limit = q.limit.unwrap_or(200).clamp(1, 500);
            let retained_from = total_receipts.saturating_sub(limit);
            let receipts = receipts.into_iter().skip(retained_from).collect::<Vec<_>>();
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "receipts": receipts,
                "totalReceipts": total_receipts,
                "truncated": retained_from > 0,
                "limit": limit,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": e,
            })),
        )
            .into_response(),
    }
}
