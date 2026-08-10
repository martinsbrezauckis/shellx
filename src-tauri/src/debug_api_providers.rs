use super::*;

#[derive(Deserialize)]
pub(super) struct PermissionBody {
    /// "allow" | "deny" — anything else maps to deny for safety.
    outcome: String,
}

fn provider_permission_decision(
    outcome: &str,
) -> (bool, crate::provider_sessions::ProviderApprovalDecision) {
    let normalized = outcome.to_ascii_lowercase();
    let allow = matches!(
        normalized.as_str(),
        "allow"
            | "allow_always"
            | "accept"
            | "acceptforsession"
            | "approved_for_session"
            | "selected"
            | "true"
            | "yes"
    );
    let decision = if !allow {
        crate::provider_sessions::ProviderApprovalDecision::Deny
    } else if matches!(
        normalized.as_str(),
        "allow_always" | "acceptforsession" | "approved_for_session"
    ) {
        crate::provider_sessions::ProviderApprovalDecision::AllowForSession
    } else {
        crate::provider_sessions::ProviderApprovalDecision::Allow
    };
    (allow, decision)
}

/// `POST /permissions/:reqId/respond {outcome}`.
///
/// Lets an orchestrator answer a pending permission request without UI
/// interaction. Returns 200 if resolved, 404 if the requestId is
/// unknown or already timed out, 400 on malformed body.
pub(super) async fn permission_respond(
    State(s): State<ApiState>,
    axum::extract::Path(req_id): axum::extract::Path<String>,
    Json(body): Json<PermissionBody>,
) -> Response {
    if req_id.is_empty() || req_id.contains('/') || req_id.contains("..") {
        return (StatusCode::BAD_REQUEST, "invalid reqId").into_response();
    }
    let (allow, provider_decision) = provider_permission_decision(&body.outcome);
    let acp_registry = s
        .app
        .state::<std::sync::Arc<crate::acp::PendingPermissionRegistry>>()
        .inner()
        .clone();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let resolved = provider_registry
        .resolve_pending_approval(&req_id, provider_decision)
        .await
        || acp_registry.resolve(&req_id, allow).await;
    if resolved {
        // #420 — emit a typed `permission-resolved` synthetic event so
        // PermissionPill (frontend lib/grouping.ts) can flip the row
        // from pending → resolved without waiting on the next
        // tool_call result event (which may never arrive on
        // deny/timeout paths).
        s.hub().record_raw_event(
            "permission-resolved",
            serde_json::json!({
                "reqId": req_id,
                "allow": allow,
                "outcome": body.outcome,
                "source": "debug-api",
            }),
        );
        Json(serde_json::json!({"ok": true, "reqId": req_id, "allow": allow})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            format!(
                "permission request '{}' not found or already resolved",
                req_id
            ),
        )
            .into_response()
    }
}

#[cfg(test)]
mod provider_permission_decision_tests {
    use super::*;

    #[test]
    fn normal_debug_api_instance_rejects_release_provider_fixture_without_prompt_data() {
        let error = require_isolated_provider_action_release_fixture(false)
            .expect_err("normal Debug API instance must reject release provider fixture");
        assert_eq!(error, PROVIDER_ACTION_RELEASE_FIXTURE_ISOLATION_ERROR);
        assert!(!error.contains("SHELLX_RELEASE_SECRET_PROMPT"));
        assert!(require_isolated_provider_action_release_fixture(true).is_ok());
    }

    #[test]
    fn preserves_session_scoped_provider_approval_outcomes() {
        assert_eq!(
            provider_permission_decision("allow_always"),
            (
                true,
                crate::provider_sessions::ProviderApprovalDecision::AllowForSession
            )
        );
        assert_eq!(
            provider_permission_decision("acceptForSession"),
            (
                true,
                crate::provider_sessions::ProviderApprovalDecision::AllowForSession
            )
        );
        assert_eq!(
            provider_permission_decision("deny"),
            (
                false,
                crate::provider_sessions::ProviderApprovalDecision::Deny
            )
        );
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct ProviderAdaptersStateQuery {
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
    #[serde(rename = "sshRemoteRuntime", alias = "ssh_remote_runtime", default)]
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    #[serde(rename = "sshWslDistro", alias = "ssh_wsl_distro", default)]
    ssh_wsl_distro: Option<String>,
}

pub(super) async fn provider_adapters_state_http(
    State(s): State<ApiState>,
    Query(q): Query<ProviderAdaptersStateQuery>,
) -> Response {
    let execution = q.transport.unwrap_or_default();
    let wsl_distro = q.wsl_distro;
    let ssh_host = q.ssh_host;
    let ssh_port = q.ssh_port;
    let ssh_key_path = match crate::provider_adapters::resolve_provider_ssh_key_path(
        q.ssh_key_vault_ref.as_deref(),
    )
    .await
    {
        Ok(path) => path,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let mut state = crate::provider_adapters::provider_adapter_state_for_execution(
        execution.clone(),
        wsl_distro.clone(),
        ssh_host.clone(),
        ssh_port,
        ssh_key_path.as_deref(),
        q.ssh_remote_runtime,
        q.ssh_wsl_distro.clone(),
    )
    .await;
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let target_transport_key =
        crate::provider_sessions::provider_execution_key_for_target_with_runtime_and_key(
            &execution,
            wsl_distro.as_deref(),
            ssh_host.as_deref(),
            ssh_port,
            q.ssh_remote_runtime,
            q.ssh_wsl_distro.as_deref(),
            q.ssh_key_vault_ref.as_deref(),
        );
    let health = provider_adapter_run_health_from_snapshots(
        &registry.runs_all_tabs(),
        &target_transport_key,
    );
    crate::provider_adapters::apply_provider_adapter_run_health(&mut state, &health);
    Json(state).into_response()
}

pub(super) async fn state_model_instruction_cards() -> Response {
    Json(crate::model_instruction_cards::model_instruction_cards_state()).into_response()
}

pub(super) fn provider_adapter_run_health_from_snapshots(
    runs: &[crate::provider_sessions::ProviderRunSnapshot],
    target_transport_key: &str,
) -> Vec<crate::provider_adapters::ProviderAdapterRunHealth> {
    let mut latest = std::collections::HashMap::<
        crate::provider_adapters::ProviderId,
        crate::provider_adapters::ProviderAdapterRunHealth,
    >::new();
    for run in runs {
        if run.transport_key != target_transport_key {
            continue;
        }
        let candidate = crate::provider_adapters::ProviderAdapterRunHealth {
            provider_id: run.provider_id,
            last_run_id: run.run_id.clone(),
            last_run_at_ms: run.updated_at_ms,
            last_error: run.error.clone(),
        };
        let replace = latest.get(&run.provider_id).map_or(true, |current| {
            candidate.last_run_at_ms > current.last_run_at_ms
        });
        if replace {
            latest.insert(run.provider_id, candidate);
        }
    }
    latest.into_values().collect()
}

pub(super) async fn provider_adapters_run_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::provider_adapters::ProviderAdapterRunRequest>,
) -> Response {
    let record_events = body.record_events.unwrap_or(true);
    let provider_id = body.provider_id;
    let transport = body.transport.clone().unwrap_or_default();
    let wsl_distro = body
        .wsl_distro
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if record_events {
        s.hub().record_raw_event(
            "provider-adapter-run-started",
            serde_json::json!({
                "providerId": provider_id,
                "cwd": body.cwd.clone(),
                "streamKind": provider_id.stream_kind(),
                "transport": transport.clone(),
                "wslDistro": wsl_distro.clone(),
            }),
        );
    }

    match crate::provider_adapters::run_provider_adapter(body).await {
        Ok(response) => {
            if record_events {
                s.hub().record_raw_event(
                    "provider-adapter-run-completed",
                    serde_json::to_value(&response).unwrap_or_else(|_| {
                        serde_json::json!({
                            "providerId": provider_id,
                            "error": "failed to serialize provider adapter response"
                        })
                    }),
                );
            }
            Json(response).into_response()
        }
        Err(e) => {
            if record_events {
                s.hub().record_raw_event(
                    "provider-adapter-run-failed",
                    serde_json::json!({
                        "providerId": provider_id,
                        "error": e.clone(),
                        "transport": transport.clone(),
                        "wslDistro": wsl_distro.clone(),
                    }),
                );
            }
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "providerId": provider_id,
                    "error": e,
                })),
            )
                .into_response()
        }
    }
}

pub(super) async fn provider_sessions_state_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let requested_key_ref = q
        .ssh_key_vault_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let state = match q.transport {
        Some(execution) => registry.state_for_tab_with_run_target(
            &tab_id,
            crate::provider_sessions::ProviderSessionRunTarget::new(
                execution,
                q.wsl_distro,
                q.ssh_host,
                q.ssh_port,
            )
            .with_ssh_key_vault_ref(requested_key_ref)
            .with_ssh_runtime(q.ssh_remote_runtime.unwrap_or_default(), q.ssh_wsl_distro),
        ),
        None => registry.state_for_tab_preferred(&tab_id),
    };
    Json(state).into_response()
}

pub(super) async fn provider_sessions_start_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::provider_sessions::ProviderSessionStartRequest>,
) -> Response {
    if body.release_fixture.is_some() {
        if let Err(error) = require_isolated_provider_action_release_fixture(
            crate::isolated_test_instance_requested(),
        ) {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "ok": false, "error": error })),
            )
                .into_response();
        }
        return provider_action_release_fixture_start(s, body).await;
    }
    let tab_id_for_autonomy = body.tab_id.clone().unwrap_or_else(|| "default".to_string());
    let provider_permission_mode = body.permission_mode.clone().unwrap_or_default();
    let shellx_autonomy = provider_permission_mode_to_shellx_autonomy(&provider_permission_mode);
    let acp_registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();

    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let hub = s.hub();
    let app = s.app.clone();
    let emit: crate::provider_sessions::ProviderSessionEmit =
        std::sync::Arc::new(move |kind, payload| {
            hub.record_raw_event(kind, payload.clone());
            let _ = tauri::Emitter::emit(&app, kind, payload);
        });

    let start_result = crate::provider_sessions::start_provider_session(registry, body, emit).await;
    match commit_provider_autonomy_after_start(
        acp_registry.inner(),
        &tab_id_for_autonomy,
        shellx_autonomy,
        start_result,
    )
    .await
    {
        Ok(run) => Json(serde_json::json!({
            "ok": true,
            "run": run,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": e,
            })),
        )
            .into_response(),
    }
}

const PROVIDER_ACTION_RELEASE_FIXTURE_ISOLATION_ERROR: &str =
    "release provider action fixture requires an isolated test instance";

fn require_isolated_provider_action_release_fixture(
    isolated_test_instance: bool,
) -> Result<(), &'static str> {
    if isolated_test_instance {
        Ok(())
    } else {
        Err(PROVIDER_ACTION_RELEASE_FIXTURE_ISOLATION_ERROR)
    }
}

const PROVIDER_ACTION_RELEASE_FIXTURE_ID: &str = "provider-action-lifecycle";
const PROVIDER_ACTION_RELEASE_FIXTURE_ACTIONS: &[&str] = &[
    "activity-ask-agent",
    "browser-explain-page",
    "browser-send",
    "right-rail-connector-action",
    "right-rail-environment-ask",
    "tasks-row-ask",
    "tasks-visible-ask",
    "work-preview-ask-fix",
    "work-preview-browser-issue-fix",
    "work-preview-stage-ask-fix",
];

fn validate_provider_action_release_fixture_cwd(cwd: &str) -> Result<String, String> {
    use std::path::Path;

    let requested = Path::new(cwd);
    let name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "release provider action cwd has no valid final component".to_string())?;
    if !name.starts_with("release-provider-action-")
        || name.len() > 96
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("release provider action cwd is not an owned fixture directory".to_string());
    }
    let metadata = std::fs::symlink_metadata(requested)
        .map_err(|error| format!("read release provider action cwd: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("release provider action cwd must be a real directory".to_string());
    }
    let canonical_home = std::fs::canonicalize(shellx_home()?)
        .map_err(|error| format!("resolve ShellX home: {error}"))?;
    let canonical_cwd = std::fs::canonicalize(requested)
        .map_err(|error| format!("resolve release provider action cwd: {error}"))?;
    if canonical_cwd.parent() != Some(canonical_home.as_path()) {
        return Err("release provider action cwd must be a direct ShellX-home child".to_string());
    }
    Ok(canonical_cwd.to_string_lossy().to_string())
}

#[deny(clippy::expect_used, clippy::unwrap_used)]
fn validate_provider_action_release_fixture_request(
    body: &crate::provider_sessions::ProviderSessionStartRequest,
) -> Result<(String, String, String, String), String> {
    use crate::provider_adapters::{
        ProviderExecutionTransport, ProviderId, ProviderPermissionMode, ProviderShellxToolExposure,
    };

    let fixture = body
        .release_fixture
        .as_ref()
        .ok_or_else(|| "missing release provider action fixture".to_string())?;
    if fixture.id != PROVIDER_ACTION_RELEASE_FIXTURE_ID
        || !PROVIDER_ACTION_RELEASE_FIXTURE_ACTIONS.contains(&fixture.action.as_str())
    {
        return Err("unknown release provider action fixture".to_string());
    }
    let expected_tab_id = format!("release-provider-action-{}", fixture.action);
    let tab_id = body
        .tab_id
        .as_deref()
        .filter(|value| *value == expected_tab_id)
        .ok_or_else(|| "release provider action fixture tab does not match action".to_string())?;
    if body.provider_id != ProviderId::CodexCli
        || !matches!(
            body.transport,
            None | Some(ProviderExecutionTransport::Local)
        )
        || body.include_mcp_probe != Some(false)
        || body.include_shellx_tooling != Some(false)
        || body.shellx_tool_exposure != Some(ProviderShellxToolExposure::Off)
        || body.persist_session != Some(false)
        || body.resume != Some(false)
        || body.resume_last != Some(false)
        || body.permission_mode != Some(ProviderPermissionMode::ReadOnly)
        || body.wsl_distro.is_some()
        || body.ssh_host.is_some()
        || body.ssh_port.is_some()
        || body.ssh_key_vault_ref.is_some()
        || body.ssh_wsl_distro.is_some()
        || body.mcp_path.is_some()
        || body.provider_conversation_id.is_some()
    {
        return Err(
            "release provider action fixture rejected non-isolated provider options".to_string(),
        );
    }
    let prompt = body.prompt.trim();
    if prompt.len() < 12 || prompt.len() > 16_384 || prompt.contains('\0') {
        return Err(
            "release provider action fixture prompt is outside the bounded contract".to_string(),
        );
    }
    let cwd = validate_provider_action_release_fixture_cwd(&body.cwd)?;
    Ok((
        tab_id.to_string(),
        cwd,
        prompt.to_string(),
        fixture.action.clone(),
    ))
}

#[deny(clippy::expect_used, clippy::unwrap_used)]
async fn provider_action_release_fixture_start(
    s: ApiState,
    body: crate::provider_sessions::ProviderSessionStartRequest,
) -> Response {
    use sha2::{Digest, Sha256};

    let (tab_id, cwd, prompt, action) =
        match validate_provider_action_release_fixture_request(&body) {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": error })),
                )
                    .into_response();
            }
        };
    let digest = format!("{:x}", Sha256::digest(prompt.as_bytes()));
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let hub = s.hub();
    let app = s.app.clone();
    let emit: crate::provider_sessions::ProviderSessionEmit =
        std::sync::Arc::new(move |kind, payload| {
            hub.record_raw_event(kind, payload.clone());
            let _ = tauri::Emitter::emit(&app, kind, payload);
        });
    match crate::provider_sessions::start_release_provider_action_fixture(
        registry, tab_id, cwd, prompt, action, digest, emit,
    )
    .await
    {
        Ok(run) => Json(serde_json::json!({ "ok": true, "run": run })).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

pub(super) async fn commit_provider_autonomy_after_start<T, E>(
    registry: &crate::acp::SessionRegistry,
    tab_id: &str,
    shellx_autonomy: &str,
    start_result: Result<T, E>,
) -> Result<T, E> {
    if start_result.is_ok() {
        registry
            .set_tab_autonomy(tab_id, shellx_autonomy.to_string())
            .await;
    }
    start_result
}

pub(super) fn provider_permission_mode_to_shellx_autonomy(
    mode: &crate::provider_adapters::ProviderPermissionMode,
) -> &'static str {
    match mode {
        crate::provider_adapters::ProviderPermissionMode::Default => "default",
        crate::provider_adapters::ProviderPermissionMode::AcceptEdits => "acceptEdits",
        crate::provider_adapters::ProviderPermissionMode::BypassPermissions => "bypassPermissions",
        crate::provider_adapters::ProviderPermissionMode::ReadOnly => "plan",
    }
}

pub(super) async fn provider_sessions_abort_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<crate::provider_sessions::ProviderSessionAbortRequest>>,
) -> Response {
    let body = body.map(|Json(b)| b);
    let tab_id = q
        .tab_id
        .or_else(|| body.as_ref().and_then(|b| b.tab_id.clone()))
        .unwrap_or_else(|| "default".to_string());
    let run_id = body.as_ref().and_then(|b| b.run_id.clone());
    let requested_transport = q
        .transport
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.transport.clone()));
    let requested_wsl_distro = q
        .wsl_distro
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.wsl_distro.clone()));
    let requested_ssh_host = q
        .ssh_host
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.ssh_host.clone()));
    let requested_ssh_port = q
        .ssh_port
        .or_else(|| body.as_ref().and_then(|b| b.ssh_port));
    let requested_ssh_key_vault_ref = q
        .ssh_key_vault_ref
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.ssh_key_vault_ref.clone()));
    let requested_ssh_remote_runtime = q
        .ssh_remote_runtime
        .or_else(|| body.as_ref().and_then(|body| body.ssh_remote_runtime))
        .unwrap_or_default();
    let requested_ssh_wsl_distro = q
        .ssh_wsl_distro
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.ssh_wsl_distro.clone()));
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let execution = requested_transport.clone().unwrap_or_default();
    let wsl_distro = requested_wsl_distro.clone();
    let ssh_host = requested_ssh_host.clone();
    let target = crate::provider_sessions::ProviderSessionRunTarget::new(
        execution.clone(),
        wsl_distro.clone(),
        ssh_host.clone(),
        requested_ssh_port,
    )
    .with_ssh_key_vault_ref(requested_ssh_key_vault_ref.clone())
    .with_ssh_runtime(
        requested_ssh_remote_runtime,
        requested_ssh_wsl_distro.clone(),
    );
    let active_before = if requested_transport.is_some() {
        registry
            .state_for_tab_with_run_target(&tab_id, target.clone())
            .active_run
    } else if let Some(run_id) = run_id.as_deref() {
        registry.active_run_by_id(&tab_id, run_id)
    } else {
        registry.state_for_tab_preferred(&tab_id).active_run
    };
    let abort_result = if requested_transport.is_some() {
        registry
            .abort_active_child_for_target(&tab_id, run_id.as_deref(), target)
            .await
    } else {
        registry
            .abort_active_child(&tab_id, run_id.as_deref())
            .await
    };
    match abort_result {
        Ok(true) => {
            if let Some(run) = active_before {
                let payload = serde_json::json!({
                    "runId": run.run_id,
                    "tabId": tab_id,
                    "providerId": run.provider_id,
                    "kind": "aborted",
                    "text": "aborted",
                    "rawType": "debug-api",
                    "providerConversationId": run.provider_conversation_id,
                    "_meta": {
                        "tabId": tab_id,
                    },
                });
                s.hub()
                    .record_raw_event("provider-session-event", payload.clone());
                let _ = tauri::Emitter::emit(&s.app, "provider-session-event", payload);
            }
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": true,
            }))
            .into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": false,
                "error": "no matching active provider session",
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": false,
                "error": e,
            })),
        )
            .into_response(),
    }
}
