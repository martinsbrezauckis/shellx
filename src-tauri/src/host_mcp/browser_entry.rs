use serde_json::Value;

use super::*;

pub(super) const BROWSER_READ_ACTIONS: &[&str] = &[
    "state",
    "tabs",
    "locks",
    "check",
    "renderedCheck",
    "observe",
    "workflows",
    "waitFor",
    "extract",
    "verify",
    "downloads",
    "evidence",
    "developerInspect",
    "teachDrafts",
];

pub(super) const BROWSER_ACT_ACTIONS: &[&str] = &[
    "navigate",
    "clickRef",
    "clickAt",
    "fillRef",
    "typeText",
    "clearSiteData",
    "runSteps",
    "workflowSave",
    "workflowReplay",
    "fillFromVault",
    "fillProfileCard",
    "captureSecretToVault",
    "readEmailCode",
    "useAgentWallet",
    "screenshot",
    "savePage",
    "resolveDialog",
    "traceOpen",
    "flightRecorderExport",
    "evaluationWrite",
    "teachPrepare",
];

fn browser_entry_action_is_write(action: &str) -> Option<bool> {
    if matches!(
        action,
        "state"
            | "tabs"
            | "locks"
            | "check"
            | "renderedcheck"
            | "observe"
            | "workflows"
            | "waitfor"
            | "extract"
            | "verify"
            | "downloads"
            | "evidence"
            | "developerinspect"
            | "teachdrafts"
    ) {
        Some(false)
    } else if matches!(
        action,
        "navigate"
            | "clickref"
            | "clickat"
            | "fillref"
            | "typetext"
            | "clearsitedata"
            | "runsteps"
            | "workflowsave"
            | "workflowreplay"
            | "fillfromvault"
            | "fillprofilecard"
            | "capturesecrettovault"
            | "reademailcode"
            | "useagentwallet"
            | "screenshot"
            | "capturescreenshot"
            | "savepage"
            | "resolvedialog"
            | "traceopen"
            | "flightrecorderexport"
            | "evaluationwrite"
            | "teachprepare"
    ) {
        Some(true)
    } else {
        None
    }
}

fn routed_browser_action(args: &mut Value) -> Result<String, String> {
    let action = mcp_arg_string(args, &["action"])
        .ok_or_else(|| "Browser entry tool requires action".to_string())?;
    if let Some(map) = args.as_object_mut() {
        map.remove("action");
    }
    Ok(action
        .trim()
        .strip_prefix("browser_")
        .unwrap_or(action.trim())
        .chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect())
}

pub(super) async fn tool_browser_read(
    mut args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let action = routed_browser_action(&mut args)?;
    if browser_entry_action_is_write(&action) != Some(false) {
        return Err(format!(
            "unsupported browser_read action '{action}'; use {}",
            BROWSER_READ_ACTIONS.join(", ")
        ));
    }
    match action.as_str() {
        "state" => tool_browser_state(args, caller_session_id).await,
        "tabs" => tool_browser_tabs(caller_session_id).await,
        "locks" => tool_browser_locks(caller_session_id).await,
        "check" => tool_browser_check(args, caller_session_id).await,
        "renderedcheck" => tool_browser_rendered_check(args, caller_session_id).await,
        "observe" => tool_browser_action("observe", args, caller_session_id).await,
        "workflows" => tool_browser_workflows(args, caller_session_id).await,
        "waitfor" => tool_browser_action("waitFor", args, caller_session_id).await,
        "extract" => tool_browser_extract(args, caller_session_id).await,
        "verify" => tool_browser_action("verify", args, caller_session_id).await,
        "downloads" => tool_browser_downloads(caller_session_id).await,
        "evidence" => tool_browser_evidence(args, caller_session_id).await,
        "developerinspect" => tool_browser_developer_inspect(args, caller_session_id).await,
        "teachdrafts" => tool_browser_teach_drafts(args, caller_session_id).await,
        _ => unreachable!("browser_read class table and dispatcher must stay synchronized"),
    }
}

pub(super) async fn tool_browser_act(
    mut args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let action = routed_browser_action(&mut args)?;
    if browser_entry_action_is_write(&action) != Some(true) {
        return Err(format!(
            "unsupported browser_act action '{action}'; use {}",
            BROWSER_ACT_ACTIONS.join(", ")
        ));
    }
    match action.as_str() {
        "navigate" => tool_browser_action("navigate", args, caller_session_id).await,
        "clickref" => tool_browser_action("clickRef", args, caller_session_id).await,
        "clickat" => tool_browser_action("clickAt", args, caller_session_id).await,
        "fillref" => tool_browser_action("fillRef", args, caller_session_id).await,
        "typetext" => tool_browser_action("typeText", args, caller_session_id).await,
        "clearsitedata" => tool_browser_action("clearSiteData", args, caller_session_id).await,
        "runsteps" => tool_browser_run_steps(args, caller_session_id).await,
        "workflowsave" => tool_browser_workflow_save(args, caller_session_id).await,
        "workflowreplay" => tool_browser_workflow_replay(args, caller_session_id).await,
        "fillfromvault" => tool_browser_action("fillFromVaultGrant", args, caller_session_id).await,
        "fillprofilecard" => {
            tool_browser_action("fillProfileCardGrant", args, caller_session_id).await
        }
        "capturesecrettovault" => {
            tool_browser_action("capturePageSecretToVault", args, caller_session_id).await
        }
        "reademailcode" => tool_browser_action("readEmailCodeGrant", args, caller_session_id).await,
        "useagentwallet" => {
            tool_browser_action("useAgentWalletGrant", args, caller_session_id).await
        }
        "screenshot" | "capturescreenshot" => {
            tool_browser_action("captureScreenshot", args, caller_session_id).await
        }
        "savepage" => tool_browser_save_page(args, caller_session_id).await,
        "resolvedialog" => tool_browser_resolve_dialog(args, caller_session_id).await,
        "traceopen" => tool_browser_trace_open(args, caller_session_id).await,
        "flightrecorderexport" => {
            tool_browser_flight_recorder_export(args, caller_session_id).await
        }
        "evaluationwrite" => tool_browser_evaluation_write(args, caller_session_id).await,
        "teachprepare" => tool_browser_teach_prepare(args, caller_session_id).await,
        _ => unreachable!("browser_act class table and dispatcher must stay synchronized"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn routed_action_accepts_compact_and_legacy_names() {
        for (input, expected) in [
            ("clickRef", "clickref"),
            ("browser_click_ref", "clickref"),
            ("workflow-replay", "workflowreplay"),
        ] {
            let mut args = json!({ "action": input, "taskId": "task-1" });
            assert_eq!(routed_browser_action(&mut args).unwrap(), expected);
            assert!(args.get("action").is_none());
            assert_eq!(args["taskId"], json!("task-1"));
        }
    }

    #[test]
    fn compact_action_classes_are_disjoint_and_screenshot_is_write_class() {
        let normalize = |action: &str| {
            action
                .chars()
                .filter(|character| !matches!(character, '_' | '-'))
                .flat_map(char::to_lowercase)
                .collect::<String>()
        };
        for action in BROWSER_READ_ACTIONS {
            assert_eq!(
                browser_entry_action_is_write(&normalize(action)),
                Some(false)
            );
        }
        for action in BROWSER_ACT_ACTIONS {
            assert_eq!(
                browser_entry_action_is_write(&normalize(action)),
                Some(true)
            );
        }
        assert_eq!(browser_entry_action_is_write("screenshot"), Some(true));
        assert!(is_write_class_tool("browser_screenshot"));
    }
}
