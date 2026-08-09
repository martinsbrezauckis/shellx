use serde_json::json;

pub(crate) fn recipe_variable_inputs(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    steps
        .iter()
        .filter(|step| recipe_step_bool(step, "valueRedacted").unwrap_or(false))
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

pub(crate) fn recipe_assertions(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut assertions = steps
        .iter()
        .filter(|step| recipe_step_string(step, "action").as_deref() == Some("verify"))
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

pub(crate) fn recipe_decision_points(steps: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut points = Vec::new();
    if steps
        .iter()
        .any(|step| recipe_step_string(step, "action").as_deref() == Some("navigate"))
    {
        points.push(json!({
            "decisionId": "domain-or-redirect-variant",
            "description": "If the destination redirects to login, consent, or a different app domain, observe and continue from the new page state instead of replaying stale selectors.",
        }));
    }
    if steps.iter().any(|step| {
        matches!(
            recipe_step_string(step, "action").as_deref(),
            Some("fillRef" | "type" | "select" | "press")
        )
    }) {
        points.push(json!({
            "decisionId": "input-source-selection",
            "description": "Resolve redacted inputs from Vault grants or explicit user input before replaying typed steps.",
        }));
    }
    if steps
        .iter()
        .any(recipe_step_needs_fresh_observation_for_redacted_text)
    {
        points.push(json!({
            "decisionId": "fresh-observation-after-redacted-text",
            "description": "A text-only wait or search was redacted because it followed secret-adjacent input; observe the live page and continue with current selectors or mediated user/Vault bindings.",
        }));
    }
    points
}

fn recipe_step_needs_fresh_observation_for_redacted_text(step: &serde_json::Value) -> bool {
    match recipe_step_string(step, "action").as_deref() {
        Some("waitFor") => {
            recipe_step_bool(step, "valueRedacted").unwrap_or(false)
                && recipe_step_string(step, "selector").is_none()
        }
        Some("findText") => match recipe_step_bool(step, "queryRedacted") {
            Some(true) => true,
            Some(false) => false,
            None => recipe_step_string(step, "query").is_none(),
        },
        _ => false,
    }
}

fn recipe_step_string(step: &serde_json::Value, key: &str) -> Option<String> {
    step.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn recipe_step_bool(step: &serde_json::Value, key: &str) -> Option<bool> {
    step.get(key).and_then(|value| value.as_bool())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_text_adds_a_fresh_observation_decision_point() {
        let steps = vec![
            json!({ "action": "waitFor", "valueRedacted": true }),
            json!({ "action": "findText", "queryRedacted": true }),
        ];

        let points = recipe_decision_points(&steps);

        assert!(points.iter().any(|point| {
            point.get("decisionId").and_then(|value| value.as_str())
                == Some("fresh-observation-after-redacted-text")
        }));
    }

    #[test]
    fn explicit_non_redacted_find_text_does_not_add_reobserve_point() {
        let steps = vec![json!({
            "action": "findText",
            "queryRedacted": false
        })];

        let points = recipe_decision_points(&steps);

        assert!(!points.iter().any(|point| {
            point.get("decisionId").and_then(|value| value.as_str())
                == Some("fresh-observation-after-redacted-text")
        }));
    }
}
