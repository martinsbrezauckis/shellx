use super::*;

use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub(super) struct PlanBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    text: String,
    /// Optional override of where plan.md lives. Defaults to the active
    /// session cwd + "/plan.md".
    #[serde(rename = "savePath")]
    save_path: Option<String>,
}

pub(super) fn canonical_path_or_existing_parent(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|e| format!("canonicalize {} failed: {}", path.display(), e));
    }
    let mut cur = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !cur.exists() {
        let file_name = cur
            .file_name()
            .ok_or_else(|| format!("{} has no existing ancestor", path.display()))?
            .to_os_string();
        missing.push(file_name);
        cur = cur
            .parent()
            .ok_or_else(|| format!("{} has no existing ancestor", path.display()))?
            .to_path_buf();
    }
    let mut out = std::fs::canonicalize(&cur)
        .map_err(|e| format!("canonicalize ancestor {} failed: {}", cur.display(), e))?;
    for part in missing.iter().rev() {
        out.push(part);
    }
    Ok(out)
}

pub(super) fn path_is_inside_base_canonical(path: &str, base: &str) -> bool {
    let path = PathBuf::from(path.trim());
    let base = PathBuf::from(base.trim());
    if path.as_os_str().is_empty() || base.as_os_str().is_empty() {
        return false;
    }
    let base_c = match std::fs::canonicalize(&base) {
        Ok(p) => p,
        Err(_) => return false,
    };
    match canonical_path_or_existing_parent(&path) {
        Ok(path_c) => path_c == base_c || path_c.starts_with(&base_c),
        Err(_) => false,
    }
}

/// `POST /plan {tabId, text, savePath?}`.
///
/// Writes plan.md to the session's cwd (or override path) and emits the
/// `plan-event` so the PlanPane right rail refreshes. Lets orchestrators
/// queue plan updates without going through the chat UI.
pub(super) async fn plan_write(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<PlanBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let Some(arc) = registry.get_existing(&tab_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            "plan writes require an existing connected session",
        )
            .into_response();
    };
    let guard = arc.lock().await;
    let info = guard.get_debug_session_info();
    drop(guard);
    let path = if let Some(p) = body.save_path.filter(|p| !p.trim().is_empty()) {
        // [H4] Security review fix: explicit savePath previously was
        // accepted unconditionally — bearer-token holder could clobber
        // any file on disk. Restrict to plan.md inside the active cwd.
        let norm = p.replace('\\', "/");
        if norm.contains("/../") || norm.starts_with("../") || norm.ends_with("/..") {
            return (
                StatusCode::BAD_REQUEST,
                "savePath: traversal segment not allowed",
            )
                .into_response();
        }
        if !norm.to_lowercase().ends_with("/plan.md") && !norm.to_lowercase().ends_with("\\plan.md")
        {
            return (
                StatusCode::BAD_REQUEST,
                "savePath: must end with /plan.md (this endpoint only writes plan files)",
            )
                .into_response();
        }
        let cwd = match info.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "savePath requires an active session cwd",
                )
                    .into_response()
            }
        };
        if !path_is_inside_base_canonical(&p, &cwd) {
            return (
                StatusCode::BAD_REQUEST,
                "savePath must be inside the active session cwd",
            )
                .into_response();
        }
        p
    } else {
        let cwd = match info.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "no cwd on session yet — connect first",
                )
                    .into_response()
            }
        };
        // Use forward slash for portability — works on Windows + WSL.
        format!("{}/plan.md", cwd.trim_end_matches(['/', '\\']))
    };
    match std::fs::write(&path, body.text.as_bytes()) {
        Ok(()) => {
            let bytes = body.text.len();
            // Emit plan-event so right-rail refreshes. Reuse the existing
            // typed event channel.
            // // #390 cross-tab leak hardening: route via `_meta.tabId` (the
            // shape the React filter looks at) rather than only a
            // top-level `tabId` field. Without `_meta.tabId` the event
            // shows up under whichever tab happens to be active when it
            // arrives, leaking the HTTP-driver's plan write into an
            // unrelated chat. The pre-existing top-level `tabId` stays for
            // back-compat with any consumer that reads it directly.
            let payload = serde_json::json!({
                "path": path,
                "tabId": tab_id.clone(),
                "source": "shellxagent",
                "_meta": { "tabId": tab_id },
            });
            let _ = tauri::Emitter::emit(&s.app, "plan-event", payload.clone());
            Json(serde_json::json!({"ok": true, "path": path, "bytes": bytes})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("plan write failed for {}: {}", path, e),
        )
            .into_response(),
    }
}

/// `POST /goal/start {tabId, objective, cwd?}` — activate goal mode for
/// a tab. Mirror of the Tauri command `set_goal_mode(true, …)` but
/// reachable from the HTTP surface so headless drivers (and the /// verification agents) can flip goal mode without touching the desktop
/// UI.
#[derive(Deserialize)]
pub(super) struct GoalStartBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    objective: String,
    /// Optional cwd override. Defaults to the session's cwd; if the
    /// session has none yet, defaults to env::current_dir.
    cwd: Option<String>,
    /// Isolated release-driver fixture state. This is deliberately part of
    /// the existing authenticated Goal route so the installed UI can prove
    /// its real lifecycle controls without adding a shipping command surface.
    /// It fails closed unless ShellX is running as an isolated test instance.
    #[serde(rename = "releaseTestState", default)]
    release_test_state: Option<String>,
}

pub(super) async fn goal_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<GoalStartBody>,
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
        Some("awaiting-review") => Some("awaiting-review"),
        Some("active-approved") => Some("active-approved"),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "releaseTestState: expected awaiting-review or active-approved",
            )
                .into_response()
        }
    };
    if release_test_state.is_some() && !crate::isolated_test_instance_requested() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "release_test_route_unavailable",
                "message": "release-test Goal fixture state is unavailable outside an isolated test instance",
            })),
        )
            .into_response();
    }
    // Resolve cwd: explicit body > existing session cwd > process cwd.
    // This is a read-only lookup: starting Goal mode for an unopened tab must
    // not materialize an empty SessionRegistry slot.
    let cwd = if let Some(c) = body.cwd.filter(|c| !c.trim().is_empty()) {
        std::path::PathBuf::from(c)
    } else {
        let registry = s
            .app
            .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
            .inner()
            .clone();
        goal_start_cwd(&registry, &tab_id).await
    };
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    // #433 — pass transport_kind so SSH skips the local stub-write.
    let (transport_kind, ssh_config) = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        match registry.get_existing(&tab_id).await {
            Some(arc) => {
                let guard = arc.lock().await;
                (
                    guard.transport_kind().to_string(),
                    guard.ssh_config().cloned(),
                )
            }
            None => ("local".to_string(), None),
        }
    };
    if release_test_state.is_some() && transport_kind != "local" {
        return (
            StatusCode::BAD_REQUEST,
            "releaseTestState: only an isolated local Goal fixture is supported",
        )
            .into_response();
    }
    orch.set_mode_with_transport_context(
        &tab_id,
        true,
        Some(body.objective.clone()),
        &cwd,
        &transport_kind,
        ssh_config,
    )
    .await;
    if let Some(target) = release_test_state {
        if let Err(error) = prepare_release_test_goal_state(&orch, &tab_id, target).await {
            orch.release_test_forget_slot(&tab_id).await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "release_test_goal_fixture_failed",
                    "message": error,
                })),
            )
                .into_response();
        }
    }
    let state = orch.get_state(&tab_id).await;
    let mut response = serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "objective": body.objective,
        "scratchboardPath": state.as_ref().map(|s| s.scratchboard_path.display().to_string()),
        "cwd": cwd.display().to_string(),
    });
    if let Some(target) = release_test_state {
        response["releaseTestState"] = serde_json::Value::String(target.to_string());
    }
    Json(response).into_response()
}

async fn goal_start_cwd(
    registry: &crate::acp::SessionRegistry,
    tab_id: &str,
) -> std::path::PathBuf {
    let Some(arc) = registry.get_existing(tab_id).await else {
        return std::env::current_dir().unwrap_or_default();
    };
    let guard = arc.lock().await;
    let info = guard.get_debug_session_info();
    match info.get("cwd").and_then(|value| value.as_str()) {
        Some(cwd) if !cwd.is_empty() => std::path::PathBuf::from(cwd),
        _ => std::env::current_dir().unwrap_or_default(),
    }
}

async fn prepare_release_test_goal_state(
    orch: &crate::goal_orchestrator::GoalOrchestrator,
    tab_id: &str,
    target: &str,
) -> Result<(), String> {
    let state = orch
        .get_state(tab_id)
        .await
        .ok_or_else(|| "isolated Goal fixture state was not created".to_string())?;
    let text = format!(
        "# Goal: {}\n\nStatus: AWAITING_APPROVAL\n\n## Phase 1 — Verify lifecycle\n- [ ] Exercise the owned RightRail control\n- [ ] Restore the exact isolated baseline\n",
        state.objective.trim()
    );
    crate::goal_orchestrator::write_scratchboard_text_for_transport(
        &state.scratchboard_path,
        &text,
        &state.transport_kind,
        state.ssh_config.as_ref(),
    )
    .await?;

    // While awaiting approval, a continuable prompt-complete only marks the
    // plan turn ready; it cannot inject a continuation. This reproduces the
    // exact state that exposes Review plan without contacting a provider.
    let continuation = orch.consider_continue(tab_id, "end_turn").await;
    if continuation.is_some() {
        return Err("isolated awaiting-review fixture unexpectedly produced a continuation".into());
    }
    let approval = orch
        .approval_status(tab_id)
        .await
        .ok_or_else(|| "isolated Goal fixture omitted approval status".to_string())?;
    if !approval.ready {
        return Err(approval
            .reason
            .unwrap_or_else(|| "isolated Goal fixture did not become reviewable".to_string()));
    }
    if target == "active-approved" && !orch.approve_plan(tab_id).await? {
        return Err("isolated Goal fixture did not enter its approved active state".into());
    }
    Ok(())
}

#[derive(Deserialize, Default)]
pub(super) struct GoalTabBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// audit — optional re-plan comment. When `/goal/reject`
    /// is called with this set, the orchestrator re-arms
    /// `awaiting_approval=true` (instead of nuking state) AND injects a
    /// structured "revise the plan per this feedback" prompt back to
    /// grok. Empty / absent comment keeps legacy reject-and-clear
    /// behavior.
    #[serde(default)]
    comment: Option<String>,
    /// Exact release-fixture cleanup. Unlike normal stop, this removes both
    /// the owned state and its in-memory tombstone so the isolated baseline
    /// can be proven byte-for-byte absent after the UI exercise.
    #[serde(rename = "releaseTestClearState", default)]
    release_test_clear_state: bool,
}

pub(super) async fn goal_stop_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    if body.release_test_clear_state {
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test Goal cleanup is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
        if matches!(
            tab_id.as_str(),
            "release-goal-plan-approve" | "release-goal-plan-replan"
        ) {
            let provider_registry = s
                .app
                .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
                .inner()
                .clone();
            if let Err(error) = provider_registry.release_test_forget_completed_tab(&tab_id) {
                return (StatusCode::CONFLICT, error).into_response();
            }
        }
        orch.release_test_forget_slot(&tab_id).await;
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "active": false,
            "releaseTestCleared": true,
        }))
        .into_response();
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    // set_mode(_, false, _, _) clears the slot — cwd is unused on the off path.
    // Off path: transport_kind is irrelevant (no stub-write fires).
    orch.set_mode(&tab_id, false, None, &cwd, "local").await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "active": false})).into_response()
}

/// `POST /goal/complete {tabId}` — authenticated HTTP fallback for the
/// same manual completion path as the desktop "Mark complete" button.
/// This closes the orchestrator when Grok finished but the host-MCP
/// stdio transport died before `grok-shell-host__goal_complete` reached
/// shellX.
pub(super) async fn goal_complete_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let prior = orch.get_state(&tab_id).await;
    let was_active = prior.as_ref().map(|s| s.active).unwrap_or(false);
    let mut scratchboard_patched = false;
    let mut scratchboard_error: Option<String> = None;
    if let Some(st) = prior.as_ref() {
        match crate::goal_orchestrator::read_scratchboard_text_for_transport(
            &st.scratchboard_path,
            &st.transport_kind,
            st.ssh_config.as_ref(),
        )
        .await
        {
            Ok(text) => {
                let patched = crate::host_mcp::patch_goal_complete_status(&text);
                if patched == text {
                    scratchboard_patched = true;
                } else if let Err(e) =
                    crate::goal_orchestrator::write_scratchboard_text_for_transport(
                        &st.scratchboard_path,
                        &patched,
                        &st.transport_kind,
                        st.ssh_config.as_ref(),
                    )
                    .await
                {
                    scratchboard_error =
                        Some(format!("write {}: {}", st.scratchboard_path.display(), e));
                } else {
                    scratchboard_patched = true;
                }
            }
            Err(e) => {
                scratchboard_error =
                    Some(format!("read {}: {}", st.scratchboard_path.display(), e));
            }
        }
    }
    orch.mark_complete(&tab_id).await;
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "active": false,
        "wasActive": was_active,
        "scratchboardPatched": scratchboard_patched,
        "scratchboardError": scratchboard_error,
    }))
    .into_response()
}

pub(super) async fn goal_pause_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    orch.pause(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "paused": true})).into_response()
}

pub(super) async fn goal_resume_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    orch.resume(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "paused": false})).into_response()
}

/// `POST /goal/approve {tabId}` — flip the plan-approval gate
/// for `tabId`. Idempotent: no-op if no goal is active or the gate is
/// already flipped. Pairs with the ✓ Approve button in PlanPane and
/// enables programmatic /goal driving from shellXagent (test
/// subagents, future scripted runs).
pub(super) async fn goal_approve_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    // #436 + #440 — query first, body fallback, then "default". Body
    // is now optional (`Option<Json<...>>`) so empty POSTs don't
    // return plaintext 400 from axum's Json extractor.
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
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
                    "error": "plan_not_ready",
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    // audit fix (replan-approve gap): inject a wake-up prompt
    // immediately on approval so grok starts executing the plan even
    // if its last turn already completed (e.g. the user took time to
    // review the revised plan after a /goal/reject with comment).
    // Mirrors the same behavior in the `approve_goal_plan` Tauri
    // command — both entry points must wake grok or the goal sits
    // idle forever.
    let mut injected = false;
    if changed {
        // #447 — Local agent saw grok drift onto a STALE goal (port file
        // read+write from a prior session) after /goal/approve. Root
        // cause: the wake-up prompt didn't include the OBJECTIVE that
        // the user just approved, so grok pulled context from wherever
        // (e.g. an older goal.md or memory). Mitigation: read the
        // active goal state's objective + scratchboard path and bake
        // them into the wake-up prompt verbatim. Now the inject text
        // is grounded in this cycle's goal.
        let active = orch.get_state(&tab_id).await;
        let prompt = crate::goal_orchestrator::approval_kickoff_prompt(active.as_ref());
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            use std::time::Duration;
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
    // #430 — emit typed goal-approve event so dispatchers can verify
    // the inject landed without polling the prompt stream. Without
    // this, /goal/approve returns injected:true but emits no
    // observable event, leaving callers to guess whether the wake-up
    // prompt reached grok.
    s.hub().record_raw_event(
        "goal-approve",
        serde_json::json!({
            "tabId": tab_id.clone(),
            "approved": changed,
            "injected": injected,
            "source": "debug-api",
        }),
    );
    if changed && !injected {
        let reason = "approval kickoff inject failed; no live session or grok stdin did not accept the prompt";
        let _ = orch.restore_approval_gate_for_retry(&tab_id, reason).await;
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "approved": false,
                "injected": false,
                "error": "approve_inject_failed",
                "message": reason,
            })),
        )
            .into_response();
    }
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "approved": changed,
        "injected": injected,
    }))
    .into_response()
}

/// `POST /goal/reject {tabId}` — reject the plan and clear
/// goal mode for `tabId`. Equivalent to `/goal/stop` but expressed
/// in approval terms so callers don't need to know the internal
/// "clear via set_mode(false)" pattern.
pub(super) async fn goal_reject_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let comment = body.comment.as_deref().map(|c| c.trim()).unwrap_or("");
    if !comment.is_empty() {
        // audit — comment provided → re-plan instead of
        // hard-rejecting. Re-arm awaiting_approval and inject a
        // structured prompt that asks grok to revise goal.md per the
        // user's feedback. Without this branch the legacy behavior
        // nuked state and silently dropped the comment.
        let replanned = orch.request_replan(&tab_id).await;
        if !replanned {
            return Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "error": "no active goal — nothing to re-plan",
            }))
            .into_response();
        }
        let prompt = format!(
            "PLAN REVISION REQUESTED. User feedback:\n\n{}\n\nUpdate `goal.md` in the current working directory: \
             rewrite the phased checklist incorporating this feedback, keep `Status: AWAITING_APPROVAL` at the top, \
             reply briefly that you have written the revised plan, and STOP. Do not begin execution — the user \
             will click ✓ Approve in the Plan tab once the new plan looks right.",
            comment
        );
        // Find the session and inject. Pattern mirrors
        // maybe_inject_goal_continuation: lock session, send prompt,
        // drop receiver. Errors logged but reported in the response
        // so the caller knows whether the inject reached grok.
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        let injected = if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            use std::time::Duration;
            let attempt = async {
                let mut sess = sess_arc.lock().await;
                sess.initiate_and_send_prompt(&prompt).await
            };
            matches!(
                tokio::time::timeout(Duration::from_secs(120), attempt).await,
                Ok(Ok(_))
            )
        } else {
            false
        };
        // #446 — if the inject failed (no live session OR session
        // refused / timed out), the replan is a no-op from grok's
        // perspective: orchestrator state is re-armed but goal.md will
        // NEVER get rewritten because nothing told grok to rewrite it.
        // Report that honestly instead of `replanned:true` (caller
        // sees the lie when goal.md doesn't change).
        if !injected {
            warn!(
                "goal /reject replan inject FAILED for tab='{}' — orchestrator re-armed but grok was not woken. goal.md will stay stale until you /connect (or send a manual prompt asking grok to rewrite the plan).",
                tab_id
            );
            return Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "replanned": false,
                "injected": false,
                "comment": comment,
                "error": "replan_inject_failed",
                "hint": "Re-/connect the tab and try again — orchestrator state IS already re-armed for the next active session.",
            }))
            .into_response();
        }
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "replanned": true,
            "injected": injected,
            "comment": comment,
        }))
        .into_response();
    }
    let cleared = orch.reject_plan(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "rejected": cleared})).into_response()
}

#[derive(Deserialize)]
pub(super) struct GoalStateQuery {
    #[serde(rename = "tabId")]
    pub(super) tab_id: Option<String>,
}

pub(super) async fn goal_state_http(
    State(s): State<ApiState>,
    Query(q): Query<GoalStateQuery>,
) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let st = orch.get_state(&tab_id).await;
    let approval_status = orch.approval_status(&tab_id).await;
    // audit — also surface the tombstone so callers can
    // distinguish "no goal ever set" (both null) from "goal just
    // cleared" (state null, lastClear populated).
    let last_clear = orch.get_last_clear(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "state": st,
        "approvalStatus": approval_status,
        "lastClear": last_clear,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn goal_start_cwd_for_missing_tab_does_not_create_session() {
        let registry = crate::acp::SessionRegistry::new();

        let cwd = goal_start_cwd(&registry, "missing-goal-tab").await;

        assert_eq!(cwd, std::env::current_dir().unwrap_or_default());
        assert!(registry.get_existing("missing-goal-tab").await.is_none());
    }
}
