use std::sync::Arc;

use tauri::AppHandle;
use tokio::time::{sleep, Duration, Instant};

use crate::shellx_browser::{
    eval_browser_engine_json, BrowserActionRequest, BrowserActionResponse, ShellxBrowserRegistry,
    BROWSER_ENGINE_EVAL_TIMEOUT,
};
use crate::shellx_browser_actions::EngineControlResult;

const BROWSER_ACTION_STABILITY_TIMEOUT_MS: u64 = 2_000;
const BROWSER_ACTION_STABILITY_TIMEOUT_MAX_MS: u64 = 5_000;
const BROWSER_ACTION_STABILITY_POLL_MS: u64 = 50;
const BROWSER_WAIT_FOR_POLL_MS: u64 = 200;

pub(crate) enum EngineControlEvalOutcome {
    Result(Box<EngineControlResult>),
    Response(Box<BrowserActionResponse>),
}

pub(crate) async fn eval_browser_engine_action_result(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
    action: &str,
    engine_label: &str,
    script: &str,
) -> Result<EngineControlEvalOutcome, String> {
    let wait_for = action == "waitFor";
    let timeout_ms = if wait_for {
        request.timeout_ms.unwrap_or(5_000).clamp(250, 15_000)
    } else {
        request
            .timeout_ms
            .unwrap_or(BROWSER_ACTION_STABILITY_TIMEOUT_MS)
            .clamp(250, BROWSER_ACTION_STABILITY_TIMEOUT_MAX_MS)
    };
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let result = eval_browser_engine_control_result(
            app,
            registry,
            request,
            action,
            engine_label,
            script,
        )
        .await?;
        let EngineControlEvalOutcome::Result(result) = result else {
            return Ok(result);
        };
        let retry = if wait_for {
            !result.ok && result.status == "notFound"
        } else {
            browser_result_waits_for_actionability(request, action, &result)
        };
        if !retry || Instant::now() >= deadline {
            return Ok(EngineControlEvalOutcome::Result(result));
        }
        sleep(Duration::from_millis(if wait_for {
            BROWSER_WAIT_FOR_POLL_MS
        } else {
            BROWSER_ACTION_STABILITY_POLL_MS
        }))
        .await;
    }
}

async fn eval_browser_engine_control_result(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
    action: &str,
    engine_label: &str,
    script: &str,
) -> Result<EngineControlEvalOutcome, String> {
    let result = match eval_browser_engine_json(app, engine_label, script.to_string()).await {
        Ok(result) => result,
        Err(err) if err == BROWSER_ENGINE_EVAL_TIMEOUT => {
            if let Some(response) = registry.record_engine_beforeunload_blocker(request, action)? {
                return Ok(EngineControlEvalOutcome::Response(Box::new(response)));
            }
            return Err(err);
        }
        Err(err) => return Err(err),
    };
    let result = serde_json::from_value(result)
        .map_err(|e| format!("Browser engine action parse failed: {}", e))?;
    Ok(EngineControlEvalOutcome::Result(Box::new(result)))
}

fn browser_result_waits_for_actionability(
    request: &BrowserActionRequest,
    action: &str,
    result: &EngineControlResult,
) -> bool {
    if !matches!(
        action,
        "click" | "clickRef" | "fillRef" | "type" | "select" | "press" | "capturePageSecretToVault"
    ) {
        return false;
    }
    if result.status == "notFound" {
        let selector_present = request
            .selector
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let ref_present = request
            .ref_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        return selector_present || ref_present;
    }
    if result.status != "notActionable" {
        return false;
    }
    let Some(actionability) = result.actionability.as_ref() else {
        return false;
    };
    if !actionability
        .failed_checks
        .iter()
        .any(|check| check == "stable")
    {
        return false;
    }
    let force_click = request.force && matches!(action, "click" | "clickRef");
    actionability
        .failed_checks
        .iter()
        .all(|check| check == "stable" || (force_click && check == "receivesEvents"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::BrowserActionabilityCheck;

    fn result_with_failed_checks(failed_checks: &[&str]) -> EngineControlResult {
        EngineControlResult {
            status: "notActionable".to_string(),
            actionability: Some(BrowserActionabilityCheck {
                failed_checks: failed_checks
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                ..BrowserActionabilityCheck::default()
            }),
            ..EngineControlResult::default()
        }
    }

    #[test]
    fn retries_only_transient_stability_failures() {
        let request = BrowserActionRequest {
            selector: Some("#target".to_string()),
            action: "clickRef".to_string(),
            ..BrowserActionRequest::default()
        };
        assert!(browser_result_waits_for_actionability(
            &request,
            "clickRef",
            &result_with_failed_checks(&["stable"]),
        ));
        assert!(!browser_result_waits_for_actionability(
            &request,
            "clickRef",
            &result_with_failed_checks(&["stable", "visible"]),
        ));
        let ref_request = BrowserActionRequest {
            ref_id: Some("dom-target".to_string()),
            action: "clickRef".to_string(),
            ..BrowserActionRequest::default()
        };
        assert!(browser_result_waits_for_actionability(
            &ref_request,
            "clickRef",
            &EngineControlResult {
                status: "notFound".to_string(),
                ..EngineControlResult::default()
            },
        ));
    }

    #[test]
    fn force_click_still_waits_for_stability_before_event_bypass() {
        let request = BrowserActionRequest {
            selector: Some("#target".to_string()),
            action: "clickRef".to_string(),
            force: true,
            ..BrowserActionRequest::default()
        };
        assert!(browser_result_waits_for_actionability(
            &request,
            "clickRef",
            &result_with_failed_checks(&["stable", "receivesEvents"]),
        ));
    }
}
