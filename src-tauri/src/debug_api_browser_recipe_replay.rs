use axum::http::StatusCode;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::time::{sleep, Duration, Instant};

use crate::debug_api::ApiState;
use crate::debug_api_browser_events::emit_browser_receipt;
use crate::shellx_browser::{
    BrowserActionResponse, BrowserRecipeReplayRequest, BrowserRecipeReplayResponse,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome;

const BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS: u64 = 10_000;

pub(crate) type BrowserRecipeReplayExecutionError = (StatusCode, Value);

pub(crate) async fn execute_browser_recipe_replay(
    state: &ApiState,
    registry: &Arc<ShellxBrowserRegistry>,
    caller_session_id: Option<&str>,
    body: BrowserRecipeReplayRequest,
) -> Result<BrowserRecipeReplayResponse, BrowserRecipeReplayExecutionError> {
    let mut plan = registry
        .browser_recipe_replay_plan(&body)
        .map_err(|error| replay_error(StatusCode::BAD_REQUEST, error, None))?;
    let dry_run = body.dry_run.unwrap_or(true);
    let mut steps_applied = 0usize;
    let mut step_results =
        crate::shellx_browser_recipes::browser_recipe_replay_planned_step_results(&plan);
    if dry_run {
        for replay_action in plan.actions.clone() {
            registry
                .ensure_browser_request_authority_for_action(
                    &replay_action.request,
                    caller_session_id,
                )
                .map_err(|error| replay_error(StatusCode::FORBIDDEN, error, None))?;
            if let Some(response) = guard_recipe_replay_action(
                state,
                registry,
                caller_session_id,
                &replay_action.request,
                false,
            )
            .await?
            {
                plan.skipped_steps
                    .push(crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                        index: replay_action.index,
                        action: Some(replay_action.request.action.clone()),
                        reason: prompt_guard_skip_reason(&response).to_string(),
                    });
                if let Some(result) = step_results
                    .iter_mut()
                    .find(|result| result.index == replay_action.index)
                {
                    *result =
                        crate::shellx_browser_recipes::browser_recipe_replay_response_step_result(
                            replay_action.index,
                            replay_action.request.action,
                            &response,
                        );
                }
            }
        }
        step_results.sort_by_key(|result| result.index);
    } else {
        step_results = plan
            .skipped_steps
            .iter()
            .map(crate::shellx_browser_recipes::browser_recipe_replay_skipped_step_result)
            .collect();
        let replay_actions = plan.actions.clone();
        for (position, replay_action) in replay_actions.iter().cloned().enumerate() {
            let action = replay_action.request;
            registry
                .ensure_browser_request_authority_for_action(&action, caller_session_id)
                .map_err(|error| replay_error(StatusCode::FORBIDDEN, error, None))?;
            let requested_action = action.action.clone();
            if let Some(response) =
                guard_recipe_replay_action(state, registry, caller_session_id, &action, true)
                    .await?
            {
                plan.skipped_steps
                    .push(crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                        index: replay_action.index,
                        action: Some(requested_action.clone()),
                        reason: prompt_guard_skip_reason(&response).to_string(),
                    });
                step_results.push(
                    crate::shellx_browser_recipes::browser_recipe_replay_response_step_result(
                        replay_action.index,
                        requested_action,
                        &response,
                    ),
                );
                for remaining in replay_actions.iter().skip(position + 1) {
                    plan.skipped_steps.push(
                        crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                            index: remaining.index,
                            action: Some(remaining.request.action.clone()),
                            reason: "blockedByPromptInjectionGuard".to_string(),
                        },
                    );
                    step_results.push(
                        crate::shellx_browser_recipes::browser_recipe_replay_failed_step_result(
                            remaining.index,
                            remaining.request.action.clone(),
                            "blockedByPromptInjectionGuard",
                        ),
                    );
                }
                break;
            }
            let response = match crate::shellx_browser::try_apply_engine_action(
                state.app(),
                registry,
                action.clone(),
            )
            .await
            {
                Ok(Some(response)) => response,
                Ok(None) => match registry.apply_action(action) {
                    Ok(response) => response,
                    Err(_) => {
                        plan.skipped_steps.push(
                            crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                                index: replay_action.index,
                                action: Some(requested_action.clone()),
                                reason: "actionApplyFailed".to_string(),
                            },
                        );
                        step_results.push(
                            crate::shellx_browser_recipes::browser_recipe_replay_failed_step_result(
                                replay_action.index,
                                requested_action,
                                "actionApplyFailed",
                            ),
                        );
                        continue;
                    }
                },
                Err(_) => {
                    plan.skipped_steps.push(
                        crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                            index: replay_action.index,
                            action: Some(requested_action.clone()),
                            reason: "engineApplyFailed".to_string(),
                        },
                    );
                    step_results.push(
                        crate::shellx_browser_recipes::browser_recipe_replay_failed_step_result(
                            replay_action.index,
                            requested_action,
                            "engineApplyFailed",
                        ),
                    );
                    continue;
                }
            };
            emit_browser_receipt(state, &response.receipt);
            step_results.push(
                crate::shellx_browser_recipes::browser_recipe_replay_response_step_result(
                    replay_action.index,
                    requested_action.clone(),
                    &response,
                ),
            );
            if response.ok && response.status == "applied" {
                steps_applied += 1;
                crate::debug_api::sync_browser_action_navigation_to_engine(
                    state.app(),
                    registry,
                    &requested_action,
                    &response,
                )
                .await
                .map_err(|error| {
                    replay_error(
                        StatusCode::BAD_REQUEST,
                        error,
                        Some(json!({ "response": response })),
                    )
                })?;
                if requested_action.trim() == "navigate" {
                    wait_for_recipe_replay_navigation_settle(registry, &response)
                        .await
                        .map_err(|error| {
                            replay_error(
                                StatusCode::BAD_REQUEST,
                                error,
                                Some(json!({ "response": response })),
                            )
                        })?;
                }
            } else {
                plan.skipped_steps
                    .push(crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                        index: replay_action.index,
                        action: Some(requested_action),
                        reason: "actionNotApplied".to_string(),
                    });
            }
        }
        step_results.sort_by_key(|result| result.index);
    }
    registry
        .replay_recipe_record(
            body,
            plan.steps_planned,
            steps_applied,
            plan.skipped_steps,
            step_results,
            plan.decision_points,
        )
        .map_err(|error| replay_error(StatusCode::BAD_REQUEST, error, None))
}

async fn guard_recipe_replay_action(
    state: &ApiState,
    registry: &Arc<ShellxBrowserRegistry>,
    caller_session_id: Option<&str>,
    action: &crate::shellx_browser::BrowserActionRequest,
    allow_observe_recovery: bool,
) -> Result<Option<BrowserActionResponse>, BrowserRecipeReplayExecutionError> {
    let mut outcome = registry
        .guard_browser_action_against_prompt_injection(action, caller_session_id)
        .map_err(|error| replay_error(StatusCode::BAD_REQUEST, error, None))?;
    let mut emitted_block_receipt_id = None;
    if let BrowserPromptGuardOutcome::Blocked(response) = &outcome {
        emit_browser_receipt(state, &response.receipt);
        emitted_block_receipt_id = Some(response.receipt.receipt_id.clone());
        if allow_observe_recovery
            && response
                .receipt
                .evidence
                .get("verdict")
                .and_then(Value::as_str)
                == Some("unavailable")
        {
            let observe_request = crate::shellx_browser::BrowserActionRequest {
                task_id: action.task_id.clone(),
                browser_tab_id: action.browser_tab_id.clone(),
                action: "observe".to_string(),
                lock_lease_id: action.lock_lease_id.clone(),
                owner_agent_id: action.owner_agent_id.clone(),
                owner_run_id: action.owner_run_id.clone(),
                ..crate::shellx_browser::BrowserActionRequest::default()
            };
            let refreshed = match crate::shellx_browser::try_apply_engine_action(
                state.app(),
                registry,
                observe_request.clone(),
            )
            .await
            {
                Ok(Some(response)) => Some(response),
                Ok(None) => registry.apply_action(observe_request).ok(),
                Err(_) => None,
            };
            if let Some(refreshed) = refreshed {
                emit_browser_receipt(state, &refreshed.receipt);
                if refreshed.ok && refreshed.status == "applied" {
                    outcome = registry
                        .guard_browser_action_against_prompt_injection(action, caller_session_id)
                        .map_err(|error| replay_error(StatusCode::BAD_REQUEST, error, None))?;
                }
            }
        }
    }
    match outcome {
        BrowserPromptGuardOutcome::NotRequired => Ok(None),
        BrowserPromptGuardOutcome::Proceed(receipt) => {
            emit_browser_receipt(state, &receipt);
            Ok(None)
        }
        BrowserPromptGuardOutcome::Blocked(response) => {
            if emitted_block_receipt_id.as_deref() != Some(response.receipt.receipt_id.as_str()) {
                emit_browser_receipt(state, &response.receipt);
            }
            Ok(Some(*response))
        }
    }
}

fn prompt_guard_skip_reason(response: &BrowserActionResponse) -> &'static str {
    if response
        .receipt
        .evidence
        .get("verdict")
        .and_then(Value::as_str)
        == Some("unavailable")
    {
        "promptInjectionClassificationUnavailable"
    } else {
        "promptInjectionGuardBlocked"
    }
}

fn replay_error(
    status: StatusCode,
    error: String,
    extra: Option<Value>,
) -> BrowserRecipeReplayExecutionError {
    let mut body = json!({ "ok": false, "error": error });
    if let (Some(target), Some(extra)) = (
        body.as_object_mut(),
        extra.and_then(|value| value.as_object().cloned()),
    ) {
        target.extend(extra);
    }
    (status, body)
}

async fn wait_for_recipe_replay_navigation_settle(
    registry: &Arc<ShellxBrowserRegistry>,
    response: &BrowserActionResponse,
) -> Result<(), String> {
    let deadline =
        Instant::now() + Duration::from_millis(BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS);
    loop {
        if recipe_replay_navigation_is_settled(registry, response)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Browser recipe replay navigation did not settle within {}ms before the next saved step",
                BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS
            ));
        }
        sleep(Duration::from_millis(75)).await;
    }
}

fn recipe_replay_navigation_is_settled(
    registry: &ShellxBrowserRegistry,
    response: &BrowserActionResponse,
) -> Result<bool, String> {
    let state = registry.state();
    let tab = response
        .task_id
        .as_deref()
        .and_then(|task_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.task_id.as_deref() == Some(task_id))
        })
        .or_else(|| {
            state
                .active_browser_tab_id
                .as_deref()
                .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
        })
        .ok_or_else(|| {
            "Browser recipe replay navigation has no task tab to wait for".to_string()
        })?;
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(&state.engine))
        .ok_or_else(|| "Browser recipe replay navigation has no engine to wait for".to_string())?;
    Ok(engine.pending_url.is_none()
        && !matches!(engine.load_status.as_str(), "navigating" | "loading"))
}
