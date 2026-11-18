use super::*;
use crate::shellx_browser::{
    BrowserConsoleLogRequest, BrowserDownloadRequest, BrowserHistoryEntry,
    BrowserNetworkRecordRequest, BrowserSessionGrantRequest, BrowserTabOpenRequest,
    BrowserUploadRequest, StartBrowserTaskRequest,
};
use crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED;

#[test]
fn caller_bound_browser_tasks_reject_other_agent_sessions() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Keep implicit Browser work caller isolated".to_string(),
                profile_id: Some("task-disposable".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller-bound task starts");
    assert_eq!(task.owner_session_id.as_deref(), Some("mcp-tab-a"));

    let action = BrowserActionRequest {
        task_id: Some(task.task_id.clone()),
        action: "observe".to_string(),
        ..BrowserActionRequest::default()
    };
    registry
        .ensure_browser_request_authority_for_action(&action, Some("mcp-tab-a"))
        .expect("owning caller may act");
    let wrong_caller = registry
        .ensure_browser_request_authority_for_action(&action, Some("mcp-tab-b"))
        .expect_err("other MCP caller must not act");
    assert!(wrong_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    registry
        .ensure_browser_request_authority_for_action(&action, None)
        .expect("headerless bearer request has explicit operator authority");
    registry
        .ensure_browser_request_authority_for_task_id(&task.task_id, Some("mcp-tab-a"))
        .expect("task-owned indirect routes accept the owning caller");
    let wrong_indirect_caller = registry
        .ensure_browser_request_authority_for_task_id(&task.task_id, Some("mcp-tab-b"))
        .expect_err("task-owned indirect routes reject another caller");
    assert!(wrong_indirect_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

    let wrong_pause = registry
        .control_task_for_agent_session(
            BrowserTaskControlRequest {
                task_id: Some(task.task_id.clone()),
                action: "pause".to_string(),
                ..BrowserTaskControlRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect_err("other caller cannot pause task");
    assert!(wrong_pause.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    registry
        .control_task_for_agent_session(
            BrowserTaskControlRequest {
                task_id: Some(task.task_id),
                action: "pause".to_string(),
                ..BrowserTaskControlRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("owning caller can pause task");
}

#[test]
fn agent_session_cannot_claim_or_resume_user_takeover() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Keep user takeover operator-owned".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller-bound task starts");

    let denied_takeover = registry
        .control_task_for_agent_session(
            BrowserTaskControlRequest {
                task_id: Some(task.task_id.clone()),
                action: "userTakeover".to_string(),
                ..BrowserTaskControlRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect_err("owning agent session cannot claim user takeover authority");
    assert!(denied_takeover.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));

    registry
        .control_task_from_operator(BrowserTaskControlRequest {
            task_id: Some(task.task_id.clone()),
            action: "userTakeover".to_string(),
            ..BrowserTaskControlRequest::default()
        })
        .expect("trusted operator can take over");
    let denied_resume = registry
        .control_task_for_agent_session(
            BrowserTaskControlRequest {
                task_id: Some(task.task_id.clone()),
                action: "resume".to_string(),
                ..BrowserTaskControlRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect_err("agent session cannot resume user takeover");
    assert!(denied_resume.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));
    let denied_finish = registry
        .finish_task_for_agent_session(
            Some(task.task_id),
            Some("completed".to_string()),
            None,
            Some("mcp-tab-a"),
        )
        .expect_err("agent session cannot finish user takeover");
    assert!(denied_finish.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));
}

#[test]
fn ownerless_agent_tasks_are_retired_without_weakening_operator_authority() {
    let registry = ShellxBrowserRegistry::default();
    let missing_owner = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Reject ownerless agent creation".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            None,
        )
        .expect_err("agent task creation requires an exact caller session");
    assert!(missing_owner.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

    let operator_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Trusted Tauri operator task".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("operator task starts");
    assert_eq!(
        operator_task.owner_actor_id,
        BrowserTaskControlAuthority::Operator.actor_id()
    );
    assert_eq!(
        operator_task.owner_surface,
        BrowserTaskControlAuthority::Operator.surface_id()
    );
    assert_eq!(operator_task.owner_session_id, None);

    let debug_operator_task = registry
        .start_task_from_debug_operator(StartBrowserTaskRequest {
            goal: "Bearer-authenticated operator task".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("Debug API operator task starts");
    assert_eq!(
        debug_operator_task.owner_actor_id,
        BrowserTaskControlAuthority::Operator.actor_id()
    );
    assert_eq!(
        debug_operator_task.owner_surface,
        BrowserTaskControlAuthority::Agent.surface_id()
    );
    assert_eq!(debug_operator_task.owner_session_id, None);

    let legacy_task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Synthetic ownerless legacy Agent task".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("original-owner"),
        )
        .expect("bound task starts before legacy mutation");
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .tasks
            .iter_mut()
            .find(|task| task.task_id == legacy_task.task_id)
            .expect("legacy task remains present")
            .owner_session_id = None;
    }
    let rejected = registry
        .ensure_browser_request_authority_for_task_id(
            &legacy_task.task_id,
            Some("would-be-claimer"),
        )
        .expect_err("an ownerless Agent task cannot be claimed by any agent session");
    assert!(rejected.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    registry
        .ensure_browser_request_authority_for_task_id(&legacy_task.task_id, None)
        .expect("trusted operator authority remains available for cleanup");
}

#[test]
fn caller_bound_actions_reject_own_task_paired_with_foreign_tab_before_dispatch() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller A".to_string(),
                profile_id: Some("task-disposable".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller A task");
    let task_b = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller B".to_string(),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect("caller B task");
    let foreign_tab_id = registry
        .tabs_for_agent_session("mcp-tab-a")
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_a.task_id.as_str()))
        .expect("caller A tab")
        .browser_tab_id;

    for action in [
        "readEmailCodeGrant",
        "useAgentWalletGrant",
        "fillFromVaultGrant",
        "fillProfileCardGrant",
        "clickRef",
    ] {
        let error = registry
            .ensure_browser_request_authority_for_action(
                &BrowserActionRequest {
                    browser_tab_id: Some(foreign_tab_id.clone()),
                    task_id: Some(task_b.task_id.clone()),
                    action: action.to_string(),
                    ..BrowserActionRequest::default()
                },
                Some("mcp-tab-b"),
            )
            .expect_err("foreign tab pairing must fail before Browser action dispatch");
        assert_eq!(
            error,
            "browserTabId/taskId mismatch for Browser action target"
        );
    }

    let personal_tab_id = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://personal.invalid/private".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("operator personal tab")
        .tab
        .browser_tab_id;
    for (action, task_id) in [
        ("readEmailCodeGrant", Some(task_b.task_id.clone())),
        ("fillFromVaultGrant", Some(task_b.task_id.clone())),
        ("clearSiteData", Some(task_b.task_id.clone())),
        ("clickRef", None),
    ] {
        let error = registry
            .ensure_browser_request_authority_for_action(
                &BrowserActionRequest {
                    browser_tab_id: Some(personal_tab_id.clone()),
                    task_id,
                    action: action.to_string(),
                    ..BrowserActionRequest::default()
                },
                Some("mcp-tab-b"),
            )
            .expect_err("authenticated agents cannot target a personal tab");
        assert!(error.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    }
}

#[test]
fn caller_scoped_browser_reads_exclude_personal_and_other_agent_state() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller A private navigation".to_string(),
                profile_id: Some("task-disposable".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller A task");
    let task_b = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller B private navigation".to_string(),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect("caller B task");
    {
        let mut state = lock_or_recover(&registry.state);
        state.history.extend([
            BrowserHistoryEntry {
                history_id: "history-a".to_string(),
                task_id: Some(task_a.task_id.clone()),
                profile_id: "task-disposable".to_string(),
                url: "https://caller-a.invalid/private".to_string(),
                title: Some("Caller A".to_string()),
                visited_at_ms: 3,
            },
            BrowserHistoryEntry {
                history_id: "history-b".to_string(),
                task_id: Some(task_b.task_id.clone()),
                profile_id: "agent-work".to_string(),
                url: "https://caller-b.invalid/private".to_string(),
                title: Some("Caller B".to_string()),
                visited_at_ms: 2,
            },
            BrowserHistoryEntry {
                history_id: "history-personal".to_string(),
                task_id: None,
                profile_id: "personal".to_string(),
                url: "https://personal.invalid/private".to_string(),
                title: Some("Personal".to_string()),
                visited_at_ms: 1,
            },
        ]);
    }
    for (task, label) in [(&task_a, "a"), (&task_b, "b")] {
        registry
            .request_download_intent(BrowserDownloadRequest {
                task_id: Some(task.task_id.clone()),
                url: format!("https://caller-{label}.invalid/private-download"),
                reason: format!("Caller {label} download"),
                ..BrowserDownloadRequest::default()
            })
            .expect("task-owned download");
        registry
            .request_upload_intent(BrowserUploadRequest {
                task_id: Some(task.task_id.clone()),
                file_path: format!("/synthetic/caller-{label}.txt"),
                reason: format!("Caller {label} upload"),
                ..BrowserUploadRequest::default()
            })
            .expect("task-owned upload");
        registry
            .record_agent_console_log(
                BrowserConsoleLogRequest {
                    task_id: Some(task.task_id.clone()),
                    level: "info".to_string(),
                    message: format!("caller-{label}-private-log"),
                    ..BrowserConsoleLogRequest::default()
                },
                if label == "a" {
                    "mcp-tab-a"
                } else {
                    "mcp-tab-b"
                },
            )
            .expect("task-owned log");
        registry
            .record_network_observed(BrowserNetworkRecordRequest {
                task_id: Some(task.task_id.clone()),
                method: "GET".to_string(),
                url: format!("https://caller-{label}.invalid/private-network"),
                ..BrowserNetworkRecordRequest::default()
            })
            .expect("task-owned network");
        registry
            .request_session_grant(BrowserSessionGrantRequest {
                task_id: Some(task.task_id.clone()),
                from_profile_id: "personal".to_string(),
                to_profile_id: task.profile_id.clone(),
                reason: format!("Caller {label} grant"),
                ..BrowserSessionGrantRequest::default()
            })
            .expect("task-owned grant");
    }

    let summary = registry.summary_for_agent_session("mcp-tab-a");
    assert_eq!(summary.counts.tasks, 1);
    assert_eq!(summary.counts.tabs, 1);
    assert_eq!(summary.counts.history, 1);
    assert_eq!(summary.counts.bookmarks, 0);
    assert_eq!(
        registry
            .task_summaries_for_agent_session("mcp-tab-a")
            .into_iter()
            .map(|task| task.task_id)
            .collect::<Vec<_>>(),
        vec![task_a.task_id.clone()]
    );
    let tabs = registry.tabs_for_agent_session("mcp-tab-a");
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].task_id.as_deref(), Some(task_a.task_id.as_str()));
    let history = registry.history_for_agent_session("mcp-tab-a", None);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].history_id, "history-a");
    assert!(history.iter().all(|entry| entry.profile_id != "personal"));
    assert_eq!(registry.downloads_for_agent_session("mcp-tab-a").len(), 1);
    assert_eq!(registry.uploads_for_agent_session("mcp-tab-a").len(), 1);
    assert_eq!(
        registry
            .console_logs_for_agent_session("mcp-tab-a", None)
            .len(),
        1
    );
    assert_eq!(
        registry
            .network_entries_for_agent_session("mcp-tab-a", None)
            .len(),
        1
    );
    assert_eq!(
        registry
            .session_grants_for_agent_session("mcp-tab-a", None)
            .len(),
        1
    );
    assert!(registry
        .receipts_for_agent_session("mcp-tab-a", None)
        .iter()
        .all(|receipt| receipt.task_id.as_deref() == Some(task_a.task_id.as_str())));
    assert!(registry
        .downloads_for_agent_session("mcp-tab-a")
        .iter()
        .all(|entry| !entry
            .url
            .as_deref()
            .unwrap_or_default()
            .contains("caller-b")));

    let caller_a_before = serde_json::to_value(summary.revisions).expect("caller A revisions");
    let caller_b_before =
        serde_json::to_value(registry.summary_for_agent_session("mcp-tab-b").revisions)
            .expect("caller B revisions");
    registry
        .record_agent_console_log(
            BrowserConsoleLogRequest {
                task_id: Some(task_b.task_id.clone()),
                level: "info".to_string(),
                message: "caller-b-later-private-log".to_string(),
                ..BrowserConsoleLogRequest::default()
            },
            "mcp-tab-b",
        )
        .expect("later caller B log");
    lock_or_recover(&registry.state)
        .console_logs
        .last_mut()
        .expect("later caller B log entry")
        .t = i64::MAX - 1;
    let caller_a_after =
        serde_json::to_value(registry.summary_for_agent_session("mcp-tab-a").revisions)
            .expect("caller A revisions after caller B activity");
    let caller_b_after =
        serde_json::to_value(registry.summary_for_agent_session("mcp-tab-b").revisions)
            .expect("caller B revisions after caller B activity");
    assert_eq!(caller_a_after, caller_a_before);
    assert_ne!(caller_b_after, caller_b_before);
}

#[test]
fn browser_vault_actor_uses_authenticated_caller_not_request_owner() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Bound Vault actor".to_string(),
                profile_id: Some("task-disposable".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller task");
    let action = BrowserActionRequest {
        task_id: Some(task.task_id),
        action: "fillFromVaultGrant".to_string(),
        owner_agent_id: Some("spoofed-agent-b".to_string()),
        ..BrowserActionRequest::default()
    };
    let authenticated = crate::shellx_browser_caller::shellx_mcp_agent_identity(Some("mcp-tab-a"))
        .expect("authenticated actor");
    let actor = registry
        .vault_grant_actor_context_for_action(&action, Some(&authenticated))
        .expect("actor context");
    assert_eq!(actor.agent_id.as_deref(), Some(authenticated.as_str()));
    assert_ne!(actor.agent_id.as_deref(), Some("spoofed-agent-b"));
}
