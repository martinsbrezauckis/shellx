use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    validate_optional_task_and_tab, write_browser_json_artifact, BrowserRecipeArtifact,
    BrowserRecipeExportRequest, BrowserRecipeReplayRequest, BrowserRecipeReplayResponse,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_artifacts::browser_recipe_step_from_receipt;

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
                    task_id
                        .as_deref()
                        .map(|id| receipt.task_id.as_deref() == Some(id))
                        .unwrap_or(true)
                        && browser_tab_id
                            .as_deref()
                            .map(|id| {
                                receipt
                                    .evidence
                                    .get("browserTabId")
                                    .and_then(|value| value.as_str())
                                    == Some(id)
                            })
                            .unwrap_or(true)
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
            }),
        );
        Ok(BrowserRecipeReplayResponse {
            ok: true,
            status: status.to_string(),
            task_id,
            browser_tab_id,
            steps_planned,
            steps_applied,
            dry_run,
            receipt,
        })
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
