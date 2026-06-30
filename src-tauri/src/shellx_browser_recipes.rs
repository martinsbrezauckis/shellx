use std::path::Path;

use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    validate_optional_task_and_tab, write_browser_json_artifact, BrowserActionRequest,
    BrowserRecipeArtifact, BrowserRecipeExportRequest, BrowserRecipeReplayRequest,
    BrowserRecipeReplayResponse, BrowserRecipeReplaySkippedStep, ShellxBrowserRegistry,
};
use crate::shellx_browser_artifacts::{browser_artifact_root, browser_recipe_step_from_receipt};

#[derive(Clone, Debug, Default)]
pub(crate) struct BrowserRecipeReplayPlan {
    pub(crate) steps_planned: usize,
    pub(crate) actions: Vec<BrowserRecipeReplayAction>,
    pub(crate) skipped_steps: Vec<BrowserRecipeReplaySkippedStep>,
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
            let steps = matching_receipts
                .iter()
                .filter_map(|receipt| browser_recipe_step_from_receipt(receipt))
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
        let status = if dry_run {
            "dryRunCompleted"
        } else {
            "completed"
        };
        let steps_skipped = skipped_steps.len();
        let receipt = push_receipt(
            &mut state,
            "browserRecipeReplayCompleted",
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
            }),
        );
        Ok(BrowserRecipeReplayResponse {
            ok: true,
            status: status.to_string(),
            task_id,
            browser_tab_id,
            steps_planned,
            steps_applied,
            steps_skipped,
            skipped_steps,
            dry_run,
            receipt,
        })
    }
}

pub(crate) fn browser_recipe_replay_plan(
    request: &BrowserRecipeReplayRequest,
) -> Result<BrowserRecipeReplayPlan, String> {
    let Some(recipe) = browser_recipe_value_from_request(request)? else {
        return Ok(BrowserRecipeReplayPlan::default());
    };
    let steps = recipe
        .get("steps")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut plan = BrowserRecipeReplayPlan {
        steps_planned: steps.len(),
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

pub(crate) fn browser_recipe_value_from_request(
    request: &BrowserRecipeReplayRequest,
) -> Result<Option<serde_json::Value>, String> {
    if let Some(recipe) = request.recipe.as_ref() {
        return Ok(Some(recipe.clone()));
    }
    let Some(path) = request
        .recipe_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let text = read_browser_recipe_artifact(path)?;
    serde_json::from_str::<serde_json::Value>(&text)
        .map(Some)
        .map_err(|e| format!("parse browser recipe {} failed: {}", path, e))
}

fn read_browser_recipe_artifact(path: &str) -> Result<String, String> {
    let root = browser_artifact_root("shellx-browser-recipes")?;
    let root = root.canonicalize().map_err(|e| {
        format!(
            "resolve browser recipe root {} failed: {}",
            root.display(),
            e
        )
    })?;
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("browser recipe path must be absolute".to_string());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("resolve browser recipe {} failed: {}", path, e))?;
    if !canonical.starts_with(&root) {
        return Err(format!(
            "browser recipe path {} is outside ShellX Browser recipe artifacts",
            path
        ));
    }
    std::fs::read_to_string(&canonical)
        .map_err(|e| format!("read browser recipe {} failed: {}", canonical.display(), e))
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
            let value = recipe_step_string(step, "value")
                .filter(|_| !recipe_step_bool(step, "valueRedacted").unwrap_or(false));
            if matches!(action.as_str(), "click" | "clickRef")
                && selector.is_none()
                && ref_id.is_none()
            {
                return Err(skipped_recipe_step(index, Some(action), "missingTarget"));
            }
            if action == "waitFor" && selector.is_none() && value.is_none() {
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
                        "redactedQueryRequiresBinding",
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
            | "redactedQueryRequiresBinding"
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

fn recipe_variable_inputs(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    steps
        .iter()
        .filter(|step| {
            step.get("valueRedacted")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .enumerate()
        .map(|(index, step)| {
            json!({
                "inputId": format!("input-{}", index + 1),
                "sourceStepId": step.get("stepId").cloned().unwrap_or(serde_json::Value::Null),
                "action": step.get("action").cloned().unwrap_or(serde_json::Value::Null),
                "valueRef": "user-or-vault-supplied",
                "required": true,
                "rawValueStored": false,
            })
        })
        .collect()
}

fn recipe_assertions(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut assertions = steps
        .iter()
        .filter(|step| step.get("action").and_then(|value| value.as_str()) == Some("verify"))
        .map(|step| {
            json!({
                "assertionId": format!(
                    "assert-{}",
                    step.get("stepId")
                        .and_then(|value| value.as_str())
                        .unwrap_or("verification")
                ),
                "sourceStepId": step.get("stepId").cloned().unwrap_or(serde_json::Value::Null),
                "expectationType": step.get("expectationType").cloned().unwrap_or(serde_json::Value::Null),
                "selector": step.get("selector").cloned().unwrap_or(serde_json::Value::Null),
                "checkedTextRedacted": true,
            })
        })
        .collect::<Vec<_>>();
    if assertions.is_empty() {
        assertions.push(json!({
            "assertionId": "assert-final-observe-or-verify",
            "expectationType": "manualVerificationRequired",
            "description": "Replay should finish by observing or verifying the current page state.",
        }));
    }
    assertions
}

fn recipe_decision_points(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut points = Vec::new();
    if steps
        .iter()
        .any(|step| step.get("action").and_then(|value| value.as_str()) == Some("navigate"))
    {
        points.push(json!({
            "decisionId": "domain-or-redirect-variant",
            "description": "If the destination redirects to login, consent, or a different app domain, observe and continue from the new page state instead of replaying stale selectors.",
        }));
    }
    if steps.iter().any(|step| {
        matches!(
            step.get("action").and_then(|value| value.as_str()),
            Some("fillRef" | "type" | "select" | "press")
        )
    }) {
        points.push(json!({
            "decisionId": "input-source-selection",
            "description": "Resolve redacted inputs from Vault grants or explicit user input before replaying typed steps.",
        }));
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_path_reads_are_constrained_to_recipe_artifacts() {
        let root = browser_artifact_root("shellx-browser-recipes").expect("recipe root resolves");
        std::fs::create_dir_all(&root).expect("recipe root can be created for test");
        let outside = tempfile::NamedTempFile::new().expect("outside temp recipe");
        std::fs::write(outside.path(), r#"{"schemaVersion":2,"steps":[]}"#)
            .expect("outside temp recipe can be written");
        let request = BrowserRecipeReplayRequest {
            recipe_path: Some(outside.path().to_string_lossy().into_owned()),
            ..BrowserRecipeReplayRequest::default()
        };

        let error = browser_recipe_value_from_request(&request).expect_err("outside path rejected");

        assert!(
            error.contains("outside ShellX Browser recipe artifacts"),
            "{error}"
        );
    }

    #[test]
    fn recipe_replay_plan_converts_safe_steps_and_skips_redacted_inputs() {
        let request = BrowserRecipeReplayRequest {
            task_id: Some("browser-task-current".to_string()),
            browser_tab_id: Some("browser-tab-current".to_string()),
            recipe: Some(json!({
                "schemaVersion": 2,
                "steps": [
                    {
                        "action": "navigate",
                        "url": "https://example.com/",
                        "browserTabId": "browser-tab-old"
                    },
                    {
                        "action": "clickRef",
                        "refId": "settings",
                        "selector": "button[data-testid='settings']",
                        "force": true,
                        "browserTabId": "browser-tab-old"
                    },
                    {
                        "action": "waitFor",
                        "selector": "[data-testid='api-keys']",
                        "timeoutMs": 9000,
                        "browserTabId": "browser-tab-old"
                    },
                    {
                        "action": "fillRef",
                        "refId": "email",
                        "selector": "#email",
                        "browserTabId": "browser-tab-old",
                        "valueRedacted": true
                    },
                    {
                        "action": "select",
                        "selector": "#region",
                        "value": "eu",
                        "valueRedacted": false
                    },
                    {
                        "action": "press",
                        "selector": "#search",
                        "key": "Enter",
                        "valueRedacted": false
                    },
                    {
                        "action": "verify",
                        "key": "element",
                        "selector": "[data-testid='api-keys']"
                    },
                    {
                        "action": "capturePageSecretToVault",
                        "selector": "[data-testid='secret']"
                    },
                    {
                        "action": "findText",
                        "query": "Example Domain",
                        "queryRedacted": false
                    }
                ]
            })),
            dry_run: Some(false),
            ..BrowserRecipeReplayRequest::default()
        };

        let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

        assert_eq!(plan.steps_planned, 9);
        assert_eq!(plan.actions.len(), 3);
        assert_eq!(plan.skipped_steps.len(), 6);
        assert_eq!(plan.actions[0].request.action, "navigate");
        assert_eq!(
            plan.actions[0].request.task_id.as_deref(),
            Some("browser-task-current")
        );
        assert_eq!(
            plan.actions[0].request.browser_tab_id.as_deref(),
            Some("browser-tab-current")
        );
        assert_eq!(
            plan.actions[0].request.url.as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(plan.actions[1].request.action, "clickRef");
        assert_eq!(plan.actions[1].request.ref_id.as_deref(), Some("settings"));
        assert_eq!(
            plan.actions[1].request.selector.as_deref(),
            Some("button[data-testid='settings']")
        );
        assert!(plan.actions[1].request.force);
        assert_eq!(plan.actions[2].request.action, "waitFor");
        assert_eq!(
            plan.actions[2].request.selector.as_deref(),
            Some("[data-testid='api-keys']")
        );
        assert_eq!(plan.actions[2].request.timeout_ms, Some(9000));
        assert_eq!(plan.skipped_steps[0].action.as_deref(), Some("fillRef"));
        assert_eq!(plan.skipped_steps[0].reason, "redactedInputRequiresBinding");
        assert_eq!(plan.skipped_steps[1].action.as_deref(), Some("select"));
        assert_eq!(plan.skipped_steps[1].reason, "blockedByLiveBinding");
        assert_eq!(plan.skipped_steps[2].action.as_deref(), Some("press"));
        assert_eq!(plan.skipped_steps[2].reason, "blockedByLiveBinding");
        assert_eq!(plan.skipped_steps[3].action.as_deref(), Some("verify"));
        assert_eq!(plan.skipped_steps[3].reason, "blockedByLiveBinding");
        assert_eq!(
            plan.skipped_steps[4].action.as_deref(),
            Some("capturePageSecretToVault")
        );
        assert_eq!(plan.skipped_steps[4].reason, "blockedByLiveBinding");
        assert_eq!(plan.skipped_steps[5].action.as_deref(), Some("findText"));
        assert_eq!(plan.skipped_steps[5].reason, "blockedByLiveBinding");
    }

    #[test]
    fn recipe_replay_plan_marks_live_vault_capture_as_binding_point() {
        let request = BrowserRecipeReplayRequest {
            recipe: Some(json!({
                "schemaVersion": 2,
                "steps": [
                    {
                        "action": "navigate",
                        "url": "https://example.com/"
                    },
                    {
                        "action": "capturePageSecretToVault",
                        "selector": "[data-testid='secret']"
                    },
                    {
                        "action": "clickRef",
                        "selector": "[data-testid='continue']"
                    }
                ]
            })),
            dry_run: Some(false),
            ..BrowserRecipeReplayRequest::default()
        };

        let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

        assert_eq!(plan.steps_planned, 3);
        assert_eq!(plan.actions.len(), 1);
        assert_eq!(plan.actions[0].request.action, "navigate");
        assert_eq!(plan.skipped_steps.len(), 2);
        assert_eq!(
            plan.skipped_steps[0].action.as_deref(),
            Some("capturePageSecretToVault")
        );
        assert_eq!(
            plan.skipped_steps[0].reason,
            "liveVaultCaptureRequiresBinding"
        );
        assert_eq!(plan.skipped_steps[1].action.as_deref(), Some("clickRef"));
        assert_eq!(plan.skipped_steps[1].reason, "blockedByLiveBinding");
    }

    #[test]
    fn recipe_replay_plan_skips_incomplete_wait_steps() {
        let request = BrowserRecipeReplayRequest {
            recipe: Some(json!({
                "schemaVersion": 2,
                "steps": [
                    {
                        "action": "waitFor",
                        "valueRedacted": true
                    }
                ]
            })),
            dry_run: Some(false),
            ..BrowserRecipeReplayRequest::default()
        };

        let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

        assert_eq!(plan.steps_planned, 1);
        assert!(plan.actions.is_empty());
        assert_eq!(plan.skipped_steps.len(), 1);
        assert_eq!(plan.skipped_steps[0].action.as_deref(), Some("waitFor"));
        assert_eq!(plan.skipped_steps[0].reason, "missingTarget");
    }
}
