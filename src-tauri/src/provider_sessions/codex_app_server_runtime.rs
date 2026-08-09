use super::*;
use tokio::process::ChildStdin;

#[derive(Default)]
pub(super) struct CodexAppServerControl {
    ids: Mutex<CodexAppServerControlIds>,
}

#[derive(Default)]
struct CodexAppServerControlIds {
    thread_id: Option<String>,
    turn_id: Option<String>,
}

impl CodexAppServerControl {
    fn record_thread_id(&self, thread_id: String) {
        lock_or_recover(&self.ids).thread_id = Some(thread_id);
    }

    fn record_turn_id(&self, turn_id: String) {
        lock_or_recover(&self.ids).turn_id = Some(turn_id);
    }

    fn interrupt_request(&self) -> Option<serde_json::Value> {
        let ids = lock_or_recover(&self.ids);
        Some(serde_json::json!({
            "id": 4,
            "method": "turn/interrupt",
            "params": {
                "threadId": ids.thread_id.as_deref()?,
                "turnId": ids.turn_id.as_deref()?,
            }
        }))
    }
}

pub(super) struct CodexAppServerLineOutcome {
    pub events: Vec<ProviderSessionEvent>,
    pub terminal: Option<ProviderStreamTerminal>,
    pub approval: Option<CodexAppServerApprovalRequest>,
}

pub(super) struct CodexAppServerApprovalRequest {
    request_id: serde_json::Value,
    method: String,
    params: serde_json::Value,
}

pub(super) struct CodexAppServerLineContext<'a> {
    stdin: Option<&'a Arc<AsyncMutex<ChildStdin>>>,
    control: &'a CodexAppServerControl,
    registry: &'a ProviderSessionRegistry,
    run_id: &'a str,
    tab_id: &'a str,
}

impl<'a> CodexAppServerLineContext<'a> {
    pub(super) fn new(
        stdin: Option<&'a Arc<AsyncMutex<ChildStdin>>>,
        control: &'a CodexAppServerControl,
        registry: &'a ProviderSessionRegistry,
        run_id: &'a str,
        tab_id: &'a str,
    ) -> Self {
        Self {
            stdin,
            control,
            registry,
            run_id,
            tab_id,
        }
    }
}

pub(super) async fn process_codex_app_server_line(
    protocol: &mut CodexAppServerProtocol,
    adapter: &mut CodexAppServerEventAdapter,
    context: CodexAppServerLineContext<'_>,
    line: &str,
) -> Result<CodexAppServerLineOutcome, String> {
    let CodexAppServerLineContext {
        stdin,
        control,
        registry,
        run_id,
        tab_id,
    } = context;
    let actions = protocol.handle_line(line)?;
    let mut events = Vec::new();
    let mut terminal = None;
    let mut approval = None;

    for action in actions {
        match action {
            CodexAppServerAction::Send(value) => {
                let stdin = stdin.ok_or_else(|| {
                    "Codex app-server requested an outbound message without writable stdin"
                        .to_string()
                })?;
                write_codex_app_server_message(stdin, &value).await?;
            }
            CodexAppServerAction::ConversationId(conversation_id) => {
                control.record_thread_id(conversation_id.clone());
                registry.record_provider_conversation_id(
                    tab_id,
                    run_id,
                    ProviderId::CodexCli,
                    conversation_id,
                );
            }
            CodexAppServerAction::TurnId(turn_id) => control.record_turn_id(turn_id),
            CodexAppServerAction::Notification { method, params } => {
                if let Some(event) =
                    adapter.normalize_notification(run_id, tab_id, &method, &params)
                {
                    events.push(event);
                }
            }
            CodexAppServerAction::ApprovalRequired {
                request_id,
                method,
                params,
            } => {
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    ProviderSessionEventKind::Tool,
                    Some(format!("Codex approval required: {method}")),
                    Some(method.clone()),
                );
                event.protocol = Some("codex-app-server".to_string());
                event.status = Some(ProviderEventStatus::WaitingForApproval);
                event.item_id = first_string_field(&params, &["itemId", "item_id"]);
                event.tool_call_id = event.item_id.clone();
                event.tool_name = Some(method.clone());
                event.tool_arguments = json_content_reference(&params);
                event.turn_id = first_string_field(&params, &["turnId", "turn_id"]);
                event.provider_conversation_id =
                    first_string_field(&params, &["threadId", "thread_id"]);
                event.raw_reference = serde_json::to_vec(&serde_json::json!({
                    "id": request_id.clone(),
                    "method": method,
                    "params": params.clone(),
                }))
                .ok()
                .map(|bytes| content_reference(&bytes, true));
                events.push(event);
                approval = Some(CodexAppServerApprovalRequest {
                    request_id,
                    method,
                    params,
                });
            }
            CodexAppServerAction::Terminal(result) => {
                terminal = Some(ProviderStreamTerminal {
                    phase: if result.completed {
                        ProviderRunPhase::Completed
                    } else if result.interrupted {
                        ProviderRunPhase::Aborted
                    } else {
                        ProviderRunPhase::Failed
                    },
                    exit_code: result.completed.then_some(0),
                    error: result.error,
                });
            }
        }
    }

    Ok(CodexAppServerLineOutcome {
        events,
        terminal,
        approval,
    })
}

pub(super) async fn resolve_codex_app_server_approval(
    registry: &ProviderSessionRegistry,
    emit: &ProviderSessionEmit,
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    run_id: &str,
    tab_id: &str,
    permission_mode: &ProviderPermissionMode,
    approval: CodexAppServerApprovalRequest,
) -> Result<(), String> {
    let (request_id, decision) = match permission_mode {
        ProviderPermissionMode::BypassPermissions => {
            let request_id = format!("provider-approval-{}", uuid::Uuid::new_v4());
            emit_codex_permission_request(
                emit,
                tab_id,
                permission_mode,
                &request_id,
                &approval,
                Some(ProviderApprovalDecision::AllowForSession),
            );
            (request_id, ProviderApprovalDecision::AllowForSession)
        }
        ProviderPermissionMode::ReadOnly => {
            let request_id = format!("provider-approval-{}", uuid::Uuid::new_v4());
            emit_codex_permission_request(
                emit,
                tab_id,
                permission_mode,
                &request_id,
                &approval,
                Some(ProviderApprovalDecision::Deny),
            );
            (request_id, ProviderApprovalDecision::Deny)
        }
        ProviderPermissionMode::Default | ProviderPermissionMode::AcceptEdits => {
            let (request_id, receiver) = registry.register_pending_approval(run_id).await;
            emit_codex_permission_request(
                emit,
                tab_id,
                permission_mode,
                &request_id,
                &approval,
                None,
            );
            let decision = match tokio::time::timeout(
                Duration::from_millis(PROVIDER_APPROVAL_TIMEOUT_MS),
                receiver,
            )
            .await
            {
                Ok(Ok(decision)) => decision,
                _ => {
                    registry.forget_pending_approval(&request_id).await;
                    ProviderApprovalDecision::Deny
                }
            };
            (request_id, decision)
        }
    };

    let response = codex_approval_response(&approval, decision)?;
    write_codex_app_server_message(stdin, &response).await?;
    emit_permission_resolved(emit, tab_id, &request_id, decision);
    Ok(())
}

fn emit_codex_permission_request(
    emit: &ProviderSessionEmit,
    tab_id: &str,
    permission_mode: &ProviderPermissionMode,
    request_id: &str,
    approval: &CodexAppServerApprovalRequest,
    automatic: Option<ProviderApprovalDecision>,
) {
    let item_id = first_string_field(&approval.params, &["itemId", "item_id", "callId"])
        .unwrap_or_else(|| approval.request_id.to_string());
    let title = match approval.method.as_str() {
        "item/commandExecution/requestApproval" | "execCommandApproval" => "Codex command approval",
        "item/fileChange/requestApproval" | "applyPatchApproval" => "Codex file change approval",
        "item/permissions/requestApproval" => "Codex permission grant",
        _ => "Codex approval",
    };
    let mut payload = serde_json::json!({
        "reqId": request_id,
        "provider": "codexCli",
        "permissionMode": serde_json::to_value(permission_mode).unwrap_or_default(),
        "params": {
            "toolCall": {
                "title": title,
                "kind": approval.method,
                "toolCallId": item_id,
                "rawInput": codex_approval_ui_arguments(&approval.params),
            },
            "options": [
                {"optionId": "allow_once", "kind": "allow_once"},
                {"optionId": "allow_always", "kind": "allow_always"},
                {"optionId": "deny", "kind": "reject_once"}
            ]
        },
        "_meta": {"tabId": tab_id},
    });
    if let Some(automatic) = automatic {
        if let serde_json::Value::Object(map) = &mut payload {
            map.insert(
                if automatic == ProviderApprovalDecision::Deny {
                    "autoDenied".to_string()
                } else {
                    "autoApproved".to_string()
                },
                serde_json::Value::Bool(true),
            );
        }
    }
    crate::mcp_http::scrub_credentials(&mut payload);
    emit("permission-request", payload);
}

fn codex_approval_ui_arguments(params: &serde_json::Value) -> serde_json::Value {
    let mut visible = serde_json::Map::new();
    for key in [
        "command",
        "cwd",
        "reason",
        "grantRoot",
        "networkApprovalContext",
        "permissions",
        "additionalPermissions",
        "proposedExecpolicyAmendment",
    ] {
        if let Some(value) = params.get(key) {
            visible.insert(key.to_string(), value.clone());
        }
    }
    serde_json::Value::Object(visible)
}

fn emit_permission_resolved(
    emit: &ProviderSessionEmit,
    tab_id: &str,
    request_id: &str,
    decision: ProviderApprovalDecision,
) {
    emit(
        "permission-resolved",
        serde_json::json!({
            "requestId": request_id,
            "decision": match decision {
                ProviderApprovalDecision::Allow => "allow",
                ProviderApprovalDecision::AllowForSession => "allow_always",
                ProviderApprovalDecision::Deny => "deny",
            },
            "decisionAt": now_ms(),
            "_meta": {"tabId": tab_id},
        }),
    );
}

fn codex_approval_response(
    approval: &CodexAppServerApprovalRequest,
    decision: ProviderApprovalDecision,
) -> Result<serde_json::Value, String> {
    let result = match approval.method.as_str() {
        "item/commandExecution/requestApproval" => {
            let decision = modern_command_approval_decision(approval, decision);
            serde_json::json!({"decision": decision})
        }
        "item/fileChange/requestApproval" => {
            let decision = match decision {
                ProviderApprovalDecision::Allow => "accept",
                ProviderApprovalDecision::AllowForSession => "acceptForSession",
                ProviderApprovalDecision::Deny => "decline",
            };
            serde_json::json!({"decision": decision})
        }
        "item/permissions/requestApproval" => {
            let permissions = if decision == ProviderApprovalDecision::Deny {
                serde_json::json!({})
            } else {
                approval
                    .params
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}))
            };
            serde_json::json!({
                "permissions": permissions,
                "scope": if decision == ProviderApprovalDecision::AllowForSession {
                    "session"
                } else {
                    "turn"
                }
            })
        }
        "execCommandApproval" | "applyPatchApproval" => {
            let decision = match decision {
                ProviderApprovalDecision::Allow => serde_json::json!("approved"),
                ProviderApprovalDecision::AllowForSession => {
                    serde_json::json!("approved_for_session")
                }
                ProviderApprovalDecision::Deny => serde_json::json!({
                    "denied": {"rejection": "Denied by user in ShellX"}
                }),
            };
            serde_json::json!({"decision": decision})
        }
        method => {
            return Err(format!(
                "unsupported Codex approval response method: {method}"
            ))
        }
    };
    Ok(serde_json::json!({
        "id": approval.request_id.clone(),
        "result": result,
    }))
}

fn modern_command_approval_decision(
    approval: &CodexAppServerApprovalRequest,
    requested: ProviderApprovalDecision,
) -> &'static str {
    let Some(available) = approval
        .params
        .get("availableDecisions")
        .and_then(serde_json::Value::as_array)
    else {
        return match requested {
            ProviderApprovalDecision::Allow => "accept",
            ProviderApprovalDecision::AllowForSession => "acceptForSession",
            ProviderApprovalDecision::Deny => "decline",
        };
    };
    let includes = |candidate: &str| {
        available
            .iter()
            .any(|decision| decision.as_str() == Some(candidate))
    };
    match requested {
        ProviderApprovalDecision::Allow if includes("accept") => "accept",
        ProviderApprovalDecision::Allow => {
            if includes("decline") {
                "decline"
            } else {
                "cancel"
            }
        }
        ProviderApprovalDecision::AllowForSession if includes("acceptForSession") => {
            "acceptForSession"
        }
        ProviderApprovalDecision::AllowForSession if includes("accept") => "accept",
        ProviderApprovalDecision::AllowForSession => {
            if includes("decline") {
                "decline"
            } else {
                "cancel"
            }
        }
        ProviderApprovalDecision::Deny if includes("decline") => "decline",
        ProviderApprovalDecision::Deny => "cancel",
    }
}

pub(super) async fn interrupt_codex_app_server(
    control: &CodexAppServerControl,
    stdin: &Arc<AsyncMutex<ChildStdin>>,
) -> Result<bool, String> {
    let Some(request) = control.interrupt_request() else {
        return Ok(false);
    };
    write_codex_app_server_message(stdin, &request).await?;
    Ok(true)
}

async fn write_codex_app_server_message(
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    value: &serde_json::Value,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| format!("serialize Codex app-server message: {error}"))?;
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    tokio::time::timeout(
        Duration::from_millis(PROVIDER_SETUP_STDIN_TIMEOUT_MS),
        stdin.write_all(&bytes),
    )
    .await
    .map_err(|_| {
        format!("Codex app-server stdin write timed out after {PROVIDER_SETUP_STDIN_TIMEOUT_MS} ms")
    })?
    .map_err(|error| format!("Codex app-server stdin write failed: {error}"))
}

#[cfg(test)]
mod tests {
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
}
