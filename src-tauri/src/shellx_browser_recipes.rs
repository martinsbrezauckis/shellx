use std::{collections::BTreeSet, io::Read, path::Path};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    validate_optional_task_and_tab, write_browser_json_artifact, BrowserActionRequest,
    BrowserRecipeArtifact, BrowserRecipeExportRequest, BrowserRecipeReplayRequest,
    BrowserRecipeReplayResponse, BrowserRecipeReplaySkippedStep, BrowserRecipeReplayStepResult,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_artifacts::{
    browser_artifact_read_roots, browser_recipe_raw_input_value_from_receipt,
    browser_recipe_receipt_has_redacted_input, browser_recipe_step_from_receipt_with_context,
};
use crate::shellx_browser_recipe_analysis::{
    recipe_assertions, recipe_decision_points, recipe_variable_inputs,
};

#[derive(Clone, Debug, Default)]
pub(crate) struct BrowserRecipeReplayPlan {
    pub(crate) steps_planned: usize,
    pub(crate) actions: Vec<BrowserRecipeReplayAction>,
    pub(crate) skipped_steps: Vec<BrowserRecipeReplaySkippedStep>,
    pub(crate) decision_points: Vec<serde_json::Value>,
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserRecipeReplayAction {
    pub(crate) index: usize,
    pub(crate) request: BrowserActionRequest,
}

impl ShellxBrowserRegistry {
    pub fn export_recipe(
        &self,
        request: BrowserRecipeExportRequest,
    ) -> Result<BrowserRecipeArtifact, String> {
        let recipe_id = browser_id("browser-recipe");
        let created_at_ms = now_ms();
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser recorder recipe export requested".to_string());
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let requested_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let (task_id, browser_tab_id, profile_id, goal, steps, source_receipts) = {
            let state = lock_or_recover(&self.state);
            let task_id = requested_task_id
                .clone()
                .or_else(|| state.active_task_id.clone());
            let browser_tab_id = requested_tab_id
                .clone()
                .or_else(|| {
                    task_id.as_deref().and_then(|task_id| {
                        state
                            .tabs
                            .iter()
                            .find(|tab| tab.task_id.as_deref() == Some(task_id))
                            .map(|tab| tab.browser_tab_id.clone())
                    })
                })
                .or_else(|| state.active_browser_tab_id.clone());
            validate_optional_task_and_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())?;
            let profile_id =
                profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                    .or_else(|| state.engine.profile_id.clone());
            let goal = task_id
                .as_deref()
                .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
                .map(|task| task.goal.clone())
                .unwrap_or_else(|| reason.clone());
            let matching_receipts = state
                .receipts
                .iter()
                .filter(|receipt| {
                    let task_matches = match task_id.as_deref() {
                        Some(id) => receipt.task_id.as_deref() == Some(id),
                        None => true,
                    };
                    let tab_matches = match browser_tab_id.as_deref() {
                        Some(id) => {
                            receipt
                                .evidence
                                .get("browserTabId")
                                .and_then(|value| value.as_str())
                                == Some(id)
                        }
                        None => true,
                    };
                    task_matches && tab_matches
                })
                .collect::<Vec<_>>();
            let raw_input_values = matching_receipts
                .iter()
                .filter_map(|receipt| browser_recipe_raw_input_value_from_receipt(receipt))
                .collect::<BTreeSet<_>>();
            let mut redact_free_text_literals = false;
            let steps = matching_receipts
                .iter()
                .filter_map(|receipt| {
                    let step = browser_recipe_step_from_receipt_with_context(
                        receipt,
                        &raw_input_values,
                        redact_free_text_literals,
                    );
                    if browser_recipe_receipt_has_redacted_input(receipt) {
                        redact_free_text_literals = true;
                    }
                    step
                })
                .collect::<Vec<_>>();
            let source_receipts = matching_receipts
                .iter()
                .rev()
                .take(80)
                .map(|receipt| {
                    json!({
                        "receiptId": receipt.receipt_id,
                        "kind": receipt.kind,
                        "taskId": receipt.task_id,
                        "profileId": receipt.profile_id,
                        "browserTabId": receipt.evidence.get("browserTabId").cloned().unwrap_or(serde_json::Value::Null),
                        "recordedAtMs": receipt.t,
                    })
                })
                .collect::<Vec<_>>();
            (
                task_id,
                browser_tab_id,
                profile_id,
                goal,
                steps,
                source_receipts,
            )
        };
        let variable_inputs = recipe_variable_inputs(&steps);
        let assertions = recipe_assertions(&steps);
        let decision_points = recipe_decision_points(&steps);
        let bundle = json!({
            "schemaVersion": 2,
            "recipeId": recipe_id,
            "createdAtMs": created_at_ms,
            "reason": reason,
            "goal": goal,
            "taskId": task_id,
            "browserTabId": browser_tab_id,
            "source": "shellx-browser-recorder",
            "steps": steps,
            "variableInputs": variable_inputs,
            "assertions": assertions,
            "decisionPoints": decision_points,
            "sourceReceipts": source_receipts,
            "redactionPolicy": {
                "rawInputValues": false,
                "rawSecrets": false,
                "cookies": false,
                "headers": false,
                "queryAndFragmentRetained": false,
                "typedValueReplayRequiresVaultOrUserInput": true,
            }
        });
        let (path, bytes, sha256) = write_browser_json_artifact(
            "shellx-browser-recipes",
            "recipe",
            &recipe_id,
            created_at_ms,
            &bundle,
        )?;
        let steps_len = bundle
            .get("steps")
            .and_then(|value| value.as_array())
            .map(Vec::len)
            .unwrap_or_default();
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserRecipeExported",
            task_id.clone(),
            profile_id,
            format!("Browser recorder recipe exported: {}", recipe_id),
            json!({
                "recipeId": recipe_id.clone(),
                "browserTabId": browser_tab_id.clone(),
                "path": path.clone(),
                "bytes": bytes,
                "sha256": sha256.clone(),
                "steps": steps_len,
                "source": "shellx-browser-recipes",
                "redactionPolicy": bundle["redactionPolicy"].clone(),
            }),
        );
        Ok(BrowserRecipeArtifact {
            recipe_id,
            task_id,
            browser_tab_id,
            path,
            bytes,
            sha256,
            steps: steps_len,
            source: "shellx-browser-recipes".to_string(),
            created_at_ms,
            receipt,
        })
    }

    pub fn replay_recipe_record(
        &self,
        request: BrowserRecipeReplayRequest,
        steps_planned: usize,
        steps_applied: usize,
        skipped_steps: Vec<BrowserRecipeReplaySkippedStep>,
        step_results: Vec<BrowserRecipeReplayStepResult>,
        decision_points: Vec<serde_json::Value>,
    ) -> Result<BrowserRecipeReplayResponse, String> {
        let dry_run = request.dry_run.unwrap_or(true);
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let requested_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let mut state = lock_or_recover(&self.state);
        let task_id = requested_task_id.or_else(|| state.active_task_id.clone());
        let browser_tab_id = requested_tab_id.or_else(|| state.active_browser_tab_id.clone());
        validate_optional_task_and_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())?;
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref());
        let steps_skipped = skipped_steps.len();
        let incomplete = !dry_run && steps_skipped > 0;
        let (ok, status, receipt_kind) = if dry_run {
            (true, "dryRunCompleted", "browserRecipeReplayCompleted")
        } else if incomplete {
            (false, "incomplete", "browserRecipeReplayIncomplete")
        } else {
            (true, "completed", "browserRecipeReplayCompleted")
        };
        let receipt = push_receipt(
            &mut state,
            receipt_kind,
            task_id.clone(),
            profile_id,
            format!("Browser recipe replay {}", status),
            json!({
                "browserTabId": browser_tab_id.clone(),
                "recipePath": request.recipe_path.clone(),
                "dryRun": dry_run,
                "stepsPlanned": steps_planned,
                "stepsApplied": steps_applied,
                "stepsSkipped": steps_skipped,
                "skippedSteps": skipped_steps.clone(),
                "stepResults": step_results.clone(),
                "decisionPoints": decision_points.clone(),
            }),
        );
        Ok(BrowserRecipeReplayResponse {
            ok,
            status: status.to_string(),
            task_id,
            browser_tab_id,
            steps_planned,
            steps_applied,
            steps_skipped,
            skipped_steps,
            step_results,
            decision_points,
            dry_run,
            receipt,
        })
    }

    pub(crate) fn browser_recipe_replay_plan(
        &self,
        request: &BrowserRecipeReplayRequest,
    ) -> Result<BrowserRecipeReplayPlan, String> {
        let receipts = self.state().receipts;
        let recipe = browser_recipe_value_from_request_with_receipts(request, &receipts)?;
        browser_recipe_replay_plan_from_value(request, recipe)
    }
}

#[cfg(test)]
pub(crate) fn browser_recipe_replay_plan(
    request: &BrowserRecipeReplayRequest,
) -> Result<BrowserRecipeReplayPlan, String> {
    let recipe = browser_recipe_value_from_request(request)?;
    browser_recipe_replay_plan_from_value(request, recipe)
}

fn browser_recipe_replay_plan_from_value(
    request: &BrowserRecipeReplayRequest,
    recipe: serde_json::Value,
) -> Result<BrowserRecipeReplayPlan, String> {
    let steps = recipe
        .get("steps")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if steps.is_empty() {
        return Err("browser recipe must contain at least one replayable step".to_string());
    }
    let decision_points = recipe_decision_points(&steps);
    let mut plan = BrowserRecipeReplayPlan {
        steps_planned: steps.len(),
        decision_points,
        ..BrowserRecipeReplayPlan::default()
    };
    let mut blocked_by_live_binding = false;
    for (index, step) in steps.iter().enumerate() {
        if blocked_by_live_binding {
            plan.skipped_steps.push(skipped_recipe_step(
                index,
                recipe_step_action_name(step),
                "blockedByLiveBinding",
            ));
            continue;
        }
        match browser_recipe_action_from_step(request, index, step) {
            Ok(Some(action)) => plan.actions.push(BrowserRecipeReplayAction {
                index,
                request: action,
            }),
            Ok(None) => {}
            Err(skipped) => {
                if recipe_skip_requires_live_binding(&skipped.reason) {
                    blocked_by_live_binding = true;
                }
                plan.skipped_steps.push(skipped);
            }
        }
    }
    Ok(plan)
}

pub(crate) fn browser_recipe_replay_planned_step_results(
    plan: &BrowserRecipeReplayPlan,
) -> Vec<BrowserRecipeReplayStepResult> {
    let mut results = plan
        .actions
        .iter()
        .map(|action| BrowserRecipeReplayStepResult {
            index: action.index,
            action: Some(action.request.action.clone()),
            ok: true,
            status: "planned".to_string(),
            ..BrowserRecipeReplayStepResult::default()
        })
        .collect::<Vec<_>>();
    results.extend(
        plan.skipped_steps
            .iter()
            .map(browser_recipe_replay_skipped_step_result),
    );
    results.sort_by_key(|result| result.index);
    results
}

pub(crate) fn browser_recipe_replay_skipped_step_result(
    skipped: &BrowserRecipeReplaySkippedStep,
) -> BrowserRecipeReplayStepResult {
    BrowserRecipeReplayStepResult {
        index: skipped.index,
        action: skipped.action.clone(),
        ok: false,
        status: "skipped".to_string(),
        reason: Some(skipped.reason.clone()),
        ..BrowserRecipeReplayStepResult::default()
    }
}

pub(crate) fn browser_recipe_replay_failed_step_result(
    index: usize,
    action: String,
    reason: &str,
) -> BrowserRecipeReplayStepResult {
    BrowserRecipeReplayStepResult {
        index,
        action: Some(action),
        ok: false,
        status: "skipped".to_string(),
        reason: Some(reason.to_string()),
        ..BrowserRecipeReplayStepResult::default()
    }
}

pub(crate) fn browser_recipe_replay_response_step_result(
    index: usize,
    requested_action: String,
    response: &crate::shellx_browser::BrowserActionResponse,
) -> BrowserRecipeReplayStepResult {
    let applied = response.ok && response.status == "applied";
    BrowserRecipeReplayStepResult {
        index,
        action: Some(requested_action),
        ok: applied,
        status: response.status.clone(),
        reason: if applied {
            None
        } else {
            response
                .message
                .clone()
                .filter(|message| !message.trim().is_empty())
                .or_else(|| Some("actionNotApplied".to_string()))
        },
        task_id: response.task_id.clone(),
        current_url: response.current_url.clone(),
        step_summary: response.step_summary.clone(),
    }
}

#[cfg(test)]
pub(crate) fn browser_recipe_value_from_request(
    request: &BrowserRecipeReplayRequest,
) -> Result<serde_json::Value, String> {
    let inline_recipe = request.recipe.as_ref();
    let recipe_path = request
        .recipe_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if inline_recipe.is_some() && recipe_path.is_some() {
        return Err(
            "browser recipe replay accepts either recipe or recipePath, never both".to_string(),
        );
    }
    if let Some(recipe) = inline_recipe {
        return Ok(recipe.clone());
    }
    let path = recipe_path
        .ok_or_else(|| "browser recipe replay requires recipe or recipePath".to_string())?;
    let text = read_browser_recipe_artifact(path)?;
    serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("parse browser recipe {} failed: {}", path, e))
}

fn browser_recipe_value_from_request_with_receipts(
    request: &BrowserRecipeReplayRequest,
    receipts: &[crate::shellx_browser::BrowserReceipt],
) -> Result<serde_json::Value, String> {
    let inline_recipe = request.recipe.as_ref();
    let recipe_path = request
        .recipe_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if inline_recipe.is_some() && recipe_path.is_some() {
        return Err(
            "browser recipe replay accepts either recipe or recipePath, never both".to_string(),
        );
    }
    if let Some(recipe) = inline_recipe {
        return Ok(recipe.clone());
    }
    let path = recipe_path
        .ok_or_else(|| "browser recipe replay requires recipe or recipePath".to_string())?;
    read_receipt_bound_browser_recipe_artifact(path, receipts)
}

const MAX_BROWSER_RECIPE_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024;

fn read_receipt_bound_browser_recipe_artifact(
    path: &str,
    receipts: &[crate::shellx_browser::BrowserReceipt],
) -> Result<serde_json::Value, String> {
    let canonical = canonical_browser_recipe_artifact_path(path)?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| {
        format!(
            "read browser recipe {} metadata failed: {}",
            canonical.display(),
            e
        )
    })?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_BROWSER_RECIPE_ARTIFACT_BYTES
    {
        return Err(
            "browser recipe artifact is empty or exceeds the replay byte budget".to_string(),
        );
    }
    let file = std::fs::File::open(&canonical)
        .map_err(|e| format!("open browser recipe {} failed: {}", canonical.display(), e))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_BROWSER_RECIPE_ARTIFACT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read browser recipe {} failed: {}", canonical.display(), e))?;
    if bytes.len() as u64 != metadata.len() {
        return Err("browser recipe artifact changed while it was being read".to_string());
    }
    let recipe: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse browser recipe {} failed: {}", canonical.display(), e))?;
    let recipe_id = recipe
        .get("recipeId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "saved browser recipe is missing recipeId".to_string())?;
    if recipe
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(2)
        || recipe.get("source").and_then(serde_json::Value::as_str)
            != Some("shellx-browser-recorder")
    {
        return Err("saved browser recipe has an unsupported artifact identity".to_string());
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let matching_receipt = receipts.iter().rev().find(|receipt| {
        receipt.kind == "browserRecipeExported"
            && receipt
                .evidence
                .get("recipeId")
                .and_then(serde_json::Value::as_str)
                == Some(recipe_id)
    });
    let receipt = matching_receipt.ok_or_else(|| {
        format!("saved browser recipe {recipe_id} has no matching export receipt")
    })?;
    let receipt_path = receipt
        .evidence
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("saved browser recipe {recipe_id} export receipt has no path"))?;
    let receipt_canonical = canonical_browser_recipe_artifact_path(receipt_path)?;
    let receipt_bytes = receipt
        .evidence
        .get("bytes")
        .and_then(serde_json::Value::as_u64);
    let receipt_sha256 = receipt
        .evidence
        .get("sha256")
        .and_then(serde_json::Value::as_str);
    let receipt_source = receipt
        .evidence
        .get("source")
        .and_then(serde_json::Value::as_str);
    let artifact_task_id = recipe.get("taskId").and_then(serde_json::Value::as_str);
    if receipt_canonical != canonical
        || receipt_bytes != Some(bytes.len() as u64)
        || !receipt_sha256.is_some_and(|value| value.eq_ignore_ascii_case(&sha256))
        || receipt_source != Some("shellx-browser-recipes")
        || receipt.task_id.as_deref() != artifact_task_id
    {
        return Err(format!(
            "saved browser recipe {recipe_id} does not match its export receipt"
        ));
    }
    Ok(recipe)
}

#[cfg(test)]
fn read_browser_recipe_artifact(path: &str) -> Result<String, String> {
    let canonical = canonical_browser_recipe_artifact_path(path)?;
    std::fs::read_to_string(&canonical)
        .map_err(|e| format!("read browser recipe {} failed: {}", canonical.display(), e))
}

fn canonical_browser_recipe_artifact_path(path: &str) -> Result<std::path::PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("browser recipe path must be absolute".to_string());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("resolve browser recipe {} failed: {}", path, e))?;
    let allowed = browser_artifact_read_roots("shellx-browser-recipes")?
        .into_iter()
        .any(|root| {
            root.canonicalize()
                .map(|root| canonical.starts_with(root))
                .unwrap_or(false)
        });
    if !allowed {
        return Err(format!(
            "browser recipe path {} is outside ShellX Browser recipe artifacts",
            path
        ));
    }
    Ok(canonical)
}

fn browser_recipe_action_from_step(
    request: &BrowserRecipeReplayRequest,
    index: usize,
    step: &serde_json::Value,
) -> Result<Option<BrowserActionRequest>, BrowserRecipeReplaySkippedStep> {
    let action = recipe_step_action_name(step);
    let Some(action) = action else {
        return Err(skipped_recipe_step(index, None, "missingAction"));
    };
    if matches!(action.as_str(), "fillRef" | "type" | "select" | "press")
        && step
            .get("valueRedacted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    {
        return Err(skipped_recipe_step(
            index,
            Some(action),
            "redactedInputRequiresBinding",
        ));
    }
    match action.as_str() {
        "navigate" => {
            let Some(url) = step
                .get("url")
                .and_then(|value| value.as_str())
                .map(clean_string)
                .filter(|value| !value.is_empty())
            else {
                return Err(skipped_recipe_step(index, Some(action), "missingUrl"));
            };
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                url: Some(url),
                ..BrowserActionRequest::default()
            }))
        }
        "observe" | "extractText" | "extractMarkdown" => Ok(Some(BrowserActionRequest {
            task_id: request.task_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            action,
            ..BrowserActionRequest::default()
        })),
        "goBack" | "goForward" | "reload" => Ok(Some(BrowserActionRequest {
            task_id: request.task_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            action,
            ..BrowserActionRequest::default()
        })),
        "click" | "clickRef" | "waitFor" | "scroll" | "extractTable" => {
            let selector = recipe_step_string(step, "selector");
            let ref_id = recipe_step_string(step, "refId");
            let value_redacted = recipe_step_bool(step, "valueRedacted").unwrap_or(false);
            let value = recipe_step_string(step, "value").filter(|_| !value_redacted);
            if matches!(action.as_str(), "click" | "clickRef")
                && selector.is_none()
                && ref_id.is_none()
            {
                return Err(skipped_recipe_step(index, Some(action), "missingTarget"));
            }
            if action == "waitFor" && selector.is_none() && value.is_none() {
                if value_redacted {
                    return Err(skipped_recipe_step(
                        index,
                        Some(action),
                        "redactedTextRequiresFreshObservation",
                    ));
                }
                return Err(skipped_recipe_step(index, Some(action), "missingTarget"));
            }
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                selector,
                ref_id,
                value,
                timeout_ms: recipe_step_u64(step, "timeoutMs"),
                force: recipe_step_bool(step, "force").unwrap_or(false),
                ..BrowserActionRequest::default()
            }))
        }
        "clickAt" => {
            let (Some(x), Some(y)) = (recipe_step_f64(step, "x"), recipe_step_f64(step, "y"))
            else {
                return Err(skipped_recipe_step(
                    index,
                    Some(action),
                    "missingCoordinates",
                ));
            };
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                x: Some(x),
                y: Some(y),
                force: recipe_step_bool(step, "force").unwrap_or(false),
                ..BrowserActionRequest::default()
            }))
        }
        "select" | "press" => {
            if step
                .get("valueRedacted")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(skipped_recipe_step(
                    index,
                    Some(action),
                    "redactedInputRequiresBinding",
                ));
            }
            let selector = recipe_step_string(step, "selector");
            let ref_id = recipe_step_string(step, "refId");
            if selector.is_none() && ref_id.is_none() {
                return Err(skipped_recipe_step(index, Some(action), "missingTarget"));
            }
            let value = recipe_step_string(step, "value");
            let key = recipe_step_string(step, "key");
            if action == "select" && value.is_none() {
                return Err(skipped_recipe_step(index, Some(action), "missingValue"));
            }
            if action == "press" && value.is_none() && key.is_none() {
                return Err(skipped_recipe_step(index, Some(action), "missingKey"));
            }
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                selector,
                ref_id,
                value,
                key,
                timeout_ms: recipe_step_u64(step, "timeoutMs"),
                force: recipe_step_bool(step, "force").unwrap_or(false),
                ..BrowserActionRequest::default()
            }))
        }
        "verify" => {
            let key = recipe_step_string(step, "key")
                .or_else(|| recipe_step_string(step, "expectationType"))
                .unwrap_or_else(|| "element".to_string());
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                selector: recipe_step_string(step, "selector"),
                value: recipe_step_string(step, "value")
                    .filter(|_| !recipe_step_bool(step, "checkedTextRedacted").unwrap_or(false)),
                key: Some(key),
                timeout_ms: recipe_step_u64(step, "timeoutMs"),
                ..BrowserActionRequest::default()
            }))
        }
        "capturePageSecretToVault" => Err(skipped_recipe_step(
            index,
            Some(action),
            "liveVaultCaptureRequiresBinding",
        )),
        "fillFromVaultGrant" | "fillProfileCardGrant" | "useAgentWalletGrant" => Err(
            skipped_recipe_step(index, Some(action), "liveGrantActionRequiresBinding"),
        ),
        "findText" => {
            match step.get("queryRedacted").and_then(|value| value.as_bool()) {
                Some(false) => {}
                Some(true) | None => {
                    return Err(skipped_recipe_step(
                        index,
                        Some(action),
                        "redactedTextRequiresFreshObservation",
                    ));
                }
            }
            let Some(query) = step
                .get("query")
                .and_then(|value| value.as_str())
                .map(clean_string)
                .filter(|value| !value.is_empty())
            else {
                return Err(skipped_recipe_step(index, Some(action), "missingQuery"));
            };
            Ok(Some(BrowserActionRequest {
                task_id: request.task_id.clone(),
                browser_tab_id: request.browser_tab_id.clone(),
                action,
                value: Some(query),
                ..BrowserActionRequest::default()
            }))
        }
        _ => Err(skipped_recipe_step(
            index,
            Some(action),
            "actionRequiresContractOrUnsupportedReplay",
        )),
    }
}

fn recipe_step_action_name(step: &serde_json::Value) -> Option<String> {
    step.get("action")
        .and_then(|value| value.as_str())
        .map(clean_string)
        .filter(|value| !value.is_empty())
}

fn recipe_skip_requires_live_binding(reason: &str) -> bool {
    matches!(
        reason,
        "redactedInputRequiresBinding"
            | "redactedTextRequiresFreshObservation"
            | "liveVaultCaptureRequiresBinding"
            | "liveGrantActionRequiresBinding"
    )
}

fn recipe_step_string(step: &serde_json::Value, key: &str) -> Option<String> {
    step.get(key)
        .and_then(|value| value.as_str())
        .map(clean_string)
        .filter(|value| !value.is_empty())
}

fn recipe_step_bool(step: &serde_json::Value, key: &str) -> Option<bool> {
    step.get(key).and_then(|value| value.as_bool())
}

fn recipe_step_u64(step: &serde_json::Value, key: &str) -> Option<u64> {
    step.get(key).and_then(|value| value.as_u64())
}

fn recipe_step_f64(step: &serde_json::Value, key: &str) -> Option<f64> {
    step.get(key).and_then(|value| value.as_f64())
}

fn skipped_recipe_step(
    index: usize,
    action: Option<String>,
    reason: &str,
) -> BrowserRecipeReplaySkippedStep {
    BrowserRecipeReplaySkippedStep {
        index,
        action,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
#[path = "shellx_browser_recipes_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "shellx_browser_recipes_fixture_tests.rs"]
mod fixture_tests;
