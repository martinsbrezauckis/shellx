use super::*;

fn approval(method: &str, params: serde_json::Value) -> CodexAppServerApprovalRequest {
    CodexAppServerApprovalRequest {
        request_id: serde_json::json!("approval-1"),
        method: method.to_string(),
        params,
    }
}

#[test]
fn modern_approval_responses_preserve_once_session_and_deny() {
    let approval = approval(
        "item/commandExecution/requestApproval",
        serde_json::json!({}),
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::Allow).unwrap(),
        serde_json::json!({"id":"approval-1","result":{"decision":"accept"}})
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::AllowForSession).unwrap(),
        serde_json::json!({"id":"approval-1","result":{"decision":"acceptForSession"}})
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::Deny).unwrap(),
        serde_json::json!({"id":"approval-1","result":{"decision":"decline"}})
    );
}

#[test]
fn permission_grants_return_only_requested_subset_or_empty_deny() {
    let approval = approval(
        "item/permissions/requestApproval",
        serde_json::json!({
            "permissions": {
                "network": {"enabled": true},
                "fileSystem": {"read": ["/workspace"]}
            }
        }),
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::AllowForSession).unwrap(),
        serde_json::json!({
            "id":"approval-1",
            "result": {
                "permissions": {
                    "network": {"enabled": true},
                    "fileSystem": {"read": ["/workspace"]}
                },
                "scope": "session"
            }
        })
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::Deny).unwrap(),
        serde_json::json!({
            "id":"approval-1",
            "result": {"permissions": {}, "scope": "turn"}
        })
    );
}

#[test]
fn command_approval_respects_server_available_decisions_without_expanding_scope() {
    let allow_once_only = approval(
        "item/commandExecution/requestApproval",
        serde_json::json!({"availableDecisions": ["accept", "decline"]}),
    );
    assert_eq!(
        codex_approval_response(&allow_once_only, ProviderApprovalDecision::AllowForSession)
            .unwrap(),
        serde_json::json!({"id":"approval-1","result":{"decision":"accept"}})
    );

    let deny_only = approval(
        "item/commandExecution/requestApproval",
        serde_json::json!({"availableDecisions": ["decline", "cancel"]}),
    );
    assert_eq!(
        codex_approval_response(&deny_only, ProviderApprovalDecision::Allow).unwrap(),
        serde_json::json!({"id":"approval-1","result":{"decision":"decline"}})
    );
}

#[test]
fn legacy_approval_responses_keep_legacy_decision_vocabulary() {
    let approval = approval("execCommandApproval", serde_json::json!({}));
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::AllowForSession).unwrap(),
        serde_json::json!({
            "id":"approval-1",
            "result":{"decision":"approved_for_session"}
        })
    );
    assert_eq!(
        codex_approval_response(&approval, ProviderApprovalDecision::Deny).unwrap(),
        serde_json::json!({
            "id":"approval-1",
            "result":{"decision":{"denied":{"rejection":"Denied by user in ShellX"}}}
        })
    );
}
