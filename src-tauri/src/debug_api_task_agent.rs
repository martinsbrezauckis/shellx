//! Conversation-authorized Task creation for ShellX-launched agents.
//!
//! The authenticated Host MCP caller supplies human-facing intent and an
//! ordered worker list. ShellX derives every execution authority from the
//! exact originating tab, performs a fresh provider scan, persists the Task,
//! and optionally queues its first run. No provider output, credential, raw
//! connection secret, or caller-selected target identity enters this route.

use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tauri::Emitter;

use crate::{
    debug_api::ApiState,
    debug_api_browser_caller::optional_browser_mcp_caller_id_or_bad_request,
    task_model::{
        TaskConcurrencyPolicy, TaskDraft, TaskEnvironmentSnapshot, TaskExecutionCandidate,
        TaskExecutionPolicy, TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy,
        TaskOrigin, TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
        MAX_RECEIPTS_PER_TASK,
    },
    task_provider_catalog::{scan_task_provider_catalog, TaskProviderCatalog},
    task_runtime_app::queue_manual_run,
    task_runtime_authority::resolve_task_definition_connection_preset,
};

const DEFAULT_RUN_LIMIT_MINUTES: u32 = 10;
const MAX_RUN_LIMIT_MINUTES: u32 = 7 * 24 * 60;
const SUPPORTED_WORKERS: [&str; 4] = ["grok", "codex-cli", "claude-code", "antigravity-cli"];

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AgentTaskAction {
    Create,
    CreateAndRun,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AgentTaskActionBody {
    action: AgentTaskAction,
    user_approved: bool,
    name: String,
    instruction: String,
    #[serde(default)]
    success_criteria: Option<String>,
    #[serde(default)]
    no_change_criteria: Option<String>,
    trigger: TaskTrigger,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    workers: Vec<String>,
    #[serde(default)]
    max_run_minutes: Option<u32>,
    #[serde(default)]
    missed_run_policy: Option<TaskMissedRunPolicy>,
    #[serde(default)]
    notification_policy: Option<TaskNotificationPolicy>,
}

pub(super) async fn tasks_agent_action_http(
    headers: HeaderMap,
    State(state): State<ApiState>,
    body: Result<Json<AgentTaskActionBody>, JsonRejection>,
) -> Response {
    let caller_session_id = match optional_browser_mcp_caller_id_or_bad_request(&headers) {
        Ok(Some(caller)) => caller,
        Ok(None) => {
            return super::task_error_response(
                StatusCode::FORBIDDEN,
                "task_agent_caller_required",
                "Agent Task creation requires an authenticated ShellX session caller.",
            )
        }
        Err(response) => return *response,
    };
    let Json(body) = match body {
        Ok(body) => body,
        Err(_) => {
            return super::task_error_response(
                StatusCode::BAD_REQUEST,
                "task_agent_request_invalid",
                "Agent Task request body is invalid.",
            )
        }
    };
    if !body.user_approved {
        return super::task_error_response(
            StatusCode::FORBIDDEN,
            "task_agent_approval_required",
            "Creating a Task requires explicit user intent in the current conversation.",
        );
    }

    let ui = state.hub().ui_snapshot();
    let Some(tab) = ui
        .open_tabs
        .iter()
        .find(|tab| tab.tab_id == caller_session_id)
        .cloned()
    else {
        return super::task_error_response(
            StatusCode::CONFLICT,
            "task_agent_source_tab_unavailable",
            "The originating ShellX conversation is no longer open.",
        );
    };
    let canonical_cwd = match bounded_required_text(tab.cwd.as_deref(), 4_096) {
        Some(cwd) => cwd,
        None => {
            return super::task_error_response(
                StatusCode::CONFLICT,
                "task_agent_working_folder_unavailable",
                "The originating conversation has no usable working folder.",
            )
        }
    };
    let connection_id = tab
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string();
    let preset = match resolve_task_definition_connection_preset(&connection_id).await {
        Ok(preset) => preset,
        Err(_) => {
            return super::task_error_response(
                StatusCode::CONFLICT,
                "task_agent_environment_unavailable",
                "The originating conversation environment is no longer available.",
            )
        }
    };
    let catalogue = match scan_task_provider_catalog(&preset).await {
        Ok(catalogue) => catalogue,
        Err(_) => {
            return super::task_error_response(
                StatusCode::CONFLICT,
                "task_agent_workers_unavailable",
                "ShellX could not verify workers on the originating environment.",
            )
        }
    };
    let workers = match selected_workers(&body.workers, tab.agent_id.as_deref(), &catalogue) {
        Ok(workers) => workers,
        Err(message) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": { "code": "task_agent_workers_unavailable", "message": message },
                    "availableWorkers": ready_workers(&catalogue),
                })),
            )
                .into_response()
        }
    };
    let max_run_minutes = body.max_run_minutes.unwrap_or(DEFAULT_RUN_LIMIT_MINUTES);
    if !(1..=MAX_RUN_LIMIT_MINUTES).contains(&max_run_minutes) {
        return super::task_error_response(
            StatusCode::BAD_REQUEST,
            "task_agent_run_limit_invalid",
            "Run time limit must be between 1 minute and 7 days.",
        );
    }
    let timezone = body
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(device_timezone);
    let (permission_mode, autonomy_mode) = task_execution_policy(tab.autonomy.as_deref());
    let tool_exposure = task_tool_exposure(tab.shellx_tool_exposure.as_deref());
    let now_ms = super::current_time_ms();
    let draft = TaskDraft {
        name: body.name,
        instruction: body.instruction,
        success_criteria: body.success_criteria,
        no_change_criteria: body.no_change_criteria,
        environment: TaskEnvironmentSnapshot {
            connection_id,
            snapshot_id: catalogue.snapshot_id.clone(),
            target_key: catalogue.target.key.clone(),
            canonical_cwd,
            project_id: tab.project_id,
        },
        candidates: workers
            .iter()
            .enumerate()
            .map(|(index, provider_id)| TaskExecutionCandidate {
                order: u16::try_from(index + 1).expect("worker list is bounded"),
                provider_id: provider_id.clone(),
                model: TaskModelSelection::ProviderDefault,
                capability_requirements: Vec::new(),
                option_refs: Vec::new(),
            })
            .collect(),
        execution_policy: TaskExecutionPolicy {
            permission_mode,
            autonomy_mode,
            tool_exposure_ids: vec![tool_exposure],
        },
        attachment_refs: Vec::new(),
        workflow: None,
        vault_requirements: Vec::new(),
        trigger: body.trigger,
        timezone,
        missed_run_policy: body.missed_run_policy.unwrap_or(TaskMissedRunPolicy::Skip),
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: max_run_minutes.saturating_mul(60),
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: false,
        },
        notification_policy: body
            .notification_policy
            .unwrap_or(TaskNotificationPolicy::AttentionOnly),
        retention_policy: TaskRetentionPolicy {
            max_receipts: MAX_RECEIPTS_PER_TASK,
        },
        origin: Some(TaskOrigin {
            session_id: tab.session_id,
            tab_id: Some(caller_session_id.clone()),
        }),
    };

    let store = match super::task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let record = match store.create(draft, false, now_ms) {
        Ok(record) => record,
        Err(error) => return super::task_store_error_response(error),
    };
    let task_id = record.definition.task_id.clone();
    let revision_id = record.definition.current_revision_id.clone();
    let revision_hash = record.definition.current_revision_hash.clone();
    let _ = state.app().emit(
        "tasks-updated",
        serde_json::json!({
            "source": "shellxHostAgent",
            "taskId": task_id,
            "revisionId": revision_id,
        }),
    );
    let run = if matches!(body.action, AgentTaskAction::CreateAndRun) {
        let runtime =
            match super::task_runtime_from_state(&state) {
                Ok(runtime) => runtime,
                Err(_) => return agent_task_partial_response(
                    &record,
                    &workers,
                    max_run_minutes,
                    "Task was created, but Task execution is unavailable in this ShellX instance.",
                ),
            };
        match queue_manual_run(
            store.as_ref(),
            runtime.as_ref(),
            state.app(),
            &task_id,
            &revision_id,
            &revision_hash,
        ) {
            Ok(receipt) => Some(receipt),
            Err(_) => {
                return agent_task_partial_response(
                    &record,
                    &workers,
                    max_run_minutes,
                    "Task was created, but its first run was not queued. Review it in Tasks.",
                )
            }
        }
    } else {
        None
    };

    (
        if run.is_some() {
            StatusCode::ACCEPTED
        } else {
            StatusCode::CREATED
        },
        Json(serde_json::json!({
            "ok": true,
            "disposition": if run.is_some() { "createdAndQueued" } else { "created" },
            "task": task_summary(&record, &workers, max_run_minutes),
            "run": run,
            "review": "Open Tasks from the ShellX header to review or change this Task.",
        })),
    )
        .into_response()
}

fn selected_workers(
    requested: &[String],
    current_agent: Option<&str>,
    catalogue: &TaskProviderCatalog,
) -> Result<Vec<String>, String> {
    let mut workers = if requested.is_empty() {
        current_agent
            .map(str::trim)
            .filter(|value| {
                SUPPORTED_WORKERS.contains(value)
                    && catalogue.providers.iter().any(|provider| {
                        provider.provider_id == *value && provider.availability.can_run
                    })
            })
            .map(|value| vec![value.to_string()])
            .unwrap_or_default()
    } else {
        requested
            .iter()
            .map(|value| value.trim().to_string())
            .collect()
    };
    if workers.is_empty() {
        workers = ready_workers(catalogue).into_iter().take(1).collect();
    }
    if workers.is_empty() || workers.len() > 4 {
        return Err("Choose between one and four available workers.".to_string());
    }
    let mut seen = std::collections::BTreeSet::new();
    for worker in &workers {
        if !SUPPORTED_WORKERS.contains(&worker.as_str()) || !seen.insert(worker.clone()) {
            return Err("Worker order contains an unsupported or duplicate agent.".to_string());
        }
        let ready = catalogue
            .providers
            .iter()
            .any(|provider| provider.provider_id == *worker && provider.availability.can_run);
        if !ready {
            return Err(format!(
                "{} is not ready on the originating environment.",
                worker_label(worker)
            ));
        }
    }
    Ok(workers)
}

fn ready_workers(catalogue: &TaskProviderCatalog) -> Vec<String> {
    catalogue
        .providers
        .iter()
        .filter(|provider| provider.availability.can_run)
        .map(|provider| provider.provider_id.clone())
        .collect()
}

fn task_execution_policy(autonomy: Option<&str>) -> (String, String) {
    match autonomy.map(str::trim) {
        Some("plan") => ("default".to_string(), "plan".to_string()),
        Some("acceptEdits") => ("default".to_string(), "acceptEdits".to_string()),
        Some("bypassPermissions") => (
            "bypassPermissions".to_string(),
            "bypassPermissions".to_string(),
        ),
        _ => ("default".to_string(), "default".to_string()),
    }
}

fn task_tool_exposure(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some("hostBridge") => "hostBridge",
        Some("hostFull") => "hostFull",
        Some("off") => "off",
        _ => "nativeFirst",
    }
    .to_string()
}

fn device_timezone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|value| crate::task_time::parse_iana_timezone(value).is_ok())
        .unwrap_or_else(|| "UTC".to_string())
}

fn bounded_required_text(value: Option<&str>, max_chars: usize) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control))
    .then(|| value.to_string())
}

fn worker_label(worker: &str) -> &'static str {
    match worker {
        "grok" => "Grok",
        "codex-cli" => "Codex CLI",
        "claude-code" => "Claude Code",
        "antigravity-cli" => "Antigravity",
        _ => "That worker",
    }
}

fn task_summary(
    record: &crate::task_model::TaskDefinitionRecord,
    workers: &[String],
    max_run_minutes: u32,
) -> serde_json::Value {
    serde_json::json!({
        "taskId": record.definition.task_id,
        "revisionId": record.definition.current_revision_id,
        "revisionHash": record.definition.current_revision_hash,
        "name": record.definition.name,
        "enabled": record.definition.enabled,
        "trigger": record.revision.draft.trigger,
        "timezone": record.revision.draft.timezone,
        "workers": workers,
        "runTimeLimitMinutes": max_run_minutes,
    })
}

fn agent_task_partial_response(
    record: &crate::task_model::TaskDefinitionRecord,
    workers: &[String],
    max_run_minutes: u32,
    message: &str,
) -> Response {
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({
            "ok": false,
            "disposition": "createdRunNotQueued",
            "task": task_summary(record, workers, max_run_minutes),
            "error": { "code": "task_agent_run_not_queued", "message": message },
            "review": "Open Tasks from the ShellX header to review or start this Task.",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connections::{ConnectionProviderCapabilityTarget, ConnectionProviderScanStatus},
        task_provider_catalog::{
            TaskProviderAvailability, TaskProviderCatalogProvider, TaskProviderDefaultModelMode,
            TASK_PROVIDER_CATALOG_SCHEMA_VERSION,
        },
    };

    fn catalogue() -> TaskProviderCatalog {
        TaskProviderCatalog {
            schema_version: TASK_PROVIDER_CATALOG_SCHEMA_VERSION.to_string(),
            snapshot_id: format!("sha256:{}", "a".repeat(64)),
            generated_at_ms: 1,
            fresh_until_ms: 60_001,
            target: ConnectionProviderCapabilityTarget {
                key: "local:linux".to_string(),
                label: "This computer".to_string(),
                transport: "local".to_string(),
                runtime: "posix".to_string(),
                wsl_distro: None,
                ssh_host: None,
                ssh_port: None,
            },
            providers: SUPPORTED_WORKERS
                .iter()
                .map(|provider_id| TaskProviderCatalogProvider {
                    provider_id: (*provider_id).to_string(),
                    label: worker_label(provider_id).to_string(),
                    availability: TaskProviderAvailability {
                        status: ConnectionProviderScanStatus::Ready,
                        can_run: *provider_id != "antigravity-cli",
                        version: None,
                        detail: String::new(),
                        checked_at_ms: 1,
                    },
                    capability_guidance: Vec::new(),
                    models: Vec::new(),
                    default_model_mode: TaskProviderDefaultModelMode::ProviderDefault,
                })
                .collect(),
        }
    }

    #[test]
    fn worker_order_defaults_to_the_current_ready_agent_and_rejects_unavailable_routes() {
        assert_eq!(
            selected_workers(&[], Some("codex-cli"), &catalogue()).unwrap(),
            vec!["codex-cli"]
        );
        assert_eq!(
            selected_workers(&[], Some("antigravity-cli"), &catalogue()).unwrap(),
            vec!["grok"]
        );
        assert_eq!(
            selected_workers(
                &["claude-code".to_string(), "grok".to_string()],
                None,
                &catalogue()
            )
            .unwrap(),
            vec!["claude-code", "grok"]
        );
        assert!(
            selected_workers(&["antigravity-cli".to_string()], None, &catalogue())
                .unwrap_err()
                .contains("not ready")
        );
    }

    #[test]
    fn policy_and_tool_exposure_are_finite() {
        assert_eq!(
            task_execution_policy(Some("plan")),
            ("default".into(), "plan".into())
        );
        assert_eq!(
            task_execution_policy(Some("bypassPermissions")),
            ("bypassPermissions".into(), "bypassPermissions".into())
        );
        assert_eq!(task_tool_exposure(Some("hostFull")), "hostFull");
        assert_eq!(task_tool_exposure(Some("unknown")), "nativeFirst");
    }
}
