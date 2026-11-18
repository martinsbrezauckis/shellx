use super::*;

fn config(permission_mode: ProviderPermissionMode) -> CodexAppServerConfig {
    CodexAppServerConfig {
        cwd: "/workspace/shellx".to_string(),
        prompt: "Inspect the provider protocol".to_string(),
        persist_session: true,
        permission_mode,
        resume: CodexAppServerResume::Fresh,
        developer_instructions: Some("Use ShellX only in this session.".to_string()),
    }
}

fn initialized_protocol() -> CodexAppServerProtocol {
    let mut protocol =
        CodexAppServerProtocol::new(config(ProviderPermissionMode::BypassPermissions)).unwrap();
    protocol.start().unwrap();
    protocol
            .handle_line(
                r#"{"id":1,"result":{"userAgent":"fixture","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}"#,
            )
            .unwrap();
    protocol
}

#[test]
fn starts_with_installed_app_server_initialize_shape() {
    let mut protocol =
        CodexAppServerProtocol::new(config(ProviderPermissionMode::BypassPermissions)).unwrap();
    let request = protocol.start().unwrap();
    assert_eq!(request["id"], INITIALIZE_REQUEST_ID);
    assert_eq!(request["method"], "initialize");
    assert_eq!(request["params"]["clientInfo"]["name"], "shellx");
    assert_eq!(request["params"]["capabilities"]["experimentalApi"], false);
    assert!(protocol.start().is_err());
}

#[test]
fn initialize_response_sends_initialized_then_safe_thread_start() {
    let mut protocol =
        CodexAppServerProtocol::new(config(ProviderPermissionMode::BypassPermissions)).unwrap();
    protocol.start().unwrap();
    let actions = protocol
            .handle_line(
                r#"{"id":1,"result":{"userAgent":"fixture","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}"#,
            )
            .unwrap();
    assert_eq!(actions.len(), 2);
    let CodexAppServerAction::Send(initialized) = &actions[0] else {
        panic!("expected initialized notification")
    };
    assert_eq!(initialized["method"], "initialized");
    let CodexAppServerAction::Send(thread) = &actions[1] else {
        panic!("expected thread request")
    };
    assert_eq!(thread["method"], "thread/start");
    assert_eq!(thread["params"]["approvalPolicy"], "never");
    assert_eq!(thread["params"]["sandbox"], "danger-full-access");
    assert_eq!(thread["params"]["ephemeral"], false);
    assert_eq!(
        thread["params"]["developerInstructions"],
        "Use ShellX only in this session."
    );
}

#[test]
fn thread_response_records_native_id_and_starts_text_turn() {
    let mut protocol = initialized_protocol();
    let actions = protocol
        .handle_line(r#"{"id":2,"result":{"thread":{"id":"thread-123"}}}"#)
        .unwrap();
    assert_eq!(
        actions[0],
        CodexAppServerAction::ConversationId("thread-123".to_string())
    );
    let CodexAppServerAction::Send(turn) = &actions[1] else {
        panic!("expected turn request")
    };
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], "thread-123");
    assert_eq!(turn["params"]["input"][0]["type"], "text");
    assert_eq!(
        turn["params"]["input"][0]["text"],
        "Inspect the provider protocol"
    );
}

#[test]
fn resume_uses_thread_resume_and_preserves_permission_mapping() {
    let mut resume_config = config(ProviderPermissionMode::ReadOnly);
    resume_config.persist_session = false;
    resume_config.resume = CodexAppServerResume::ThreadId("thread-existing".to_string());
    let mut protocol = CodexAppServerProtocol::new(resume_config).unwrap();
    protocol.start().unwrap();
    let actions = protocol
            .handle_line(
                r#"{"id":1,"result":{"userAgent":"fixture","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}"#,
            )
            .unwrap();
    let CodexAppServerAction::Send(thread) = &actions[1] else {
        panic!("expected thread request")
    };
    assert_eq!(thread["method"], "thread/resume");
    assert_eq!(thread["params"]["threadId"], "thread-existing");
    assert_eq!(thread["params"]["approvalPolicy"], "never");
    assert_eq!(thread["params"]["sandbox"], "read-only");
    assert!(thread["params"].get("ephemeral").is_none());
}

#[test]
fn server_approval_requests_are_exposed_and_never_auto_approved() {
    let mut protocol = initialized_protocol();
    let actions = protocol
            .handle_line(
                r#"{"id":"approval-7","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-123","turnId":"turn-9","itemId":"item-2","command":"rm fixture","startedAtMs":1}}"#,
            )
            .unwrap();
    assert_eq!(actions.len(), 1);
    let CodexAppServerAction::ApprovalRequired {
        request_id,
        method,
        params,
    } = &actions[0]
    else {
        panic!("expected approval request")
    };
    assert_eq!(request_id, "approval-7");
    assert_eq!(method, "item/commandExecution/requestApproval");
    assert_eq!(params["command"], "rm fixture");
}

#[test]
fn typed_notifications_and_failed_terminal_are_retained() {
    let mut protocol = initialized_protocol();
    let delta = protocol
            .handle_line(
                r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-123","turnId":"turn-9","itemId":"item-1","delta":"hello"}}"#,
            )
            .unwrap();
    assert_eq!(delta.len(), 1);
    assert!(matches!(
        &delta[0],
        CodexAppServerAction::Notification { method, params }
            if method == "item/agentMessage/delta" && params["delta"] == "hello"
    ));

    let terminal = protocol
            .handle_line(
                r#"{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-9","status":"failed","items":[],"error":{"message":"fixture failure"}}}}"#,
            )
            .unwrap();
    assert!(matches!(
        terminal.last(),
        Some(CodexAppServerAction::Terminal(CodexAppServerTerminal {
            completed: false,
            interrupted: false,
            error: Some(error),
        })) if error == "fixture failure"
    ));
}

#[test]
fn malformed_or_out_of_order_messages_fail_closed() {
    let mut protocol =
        CodexAppServerProtocol::new(config(ProviderPermissionMode::Default)).unwrap();
    assert!(protocol.handle_line("not-json").is_err());
    protocol.start().unwrap();
    assert!(protocol
        .handle_line(r#"{"id":2,"result":{"thread":{"id":"too-early"}}}"#)
        .is_err());
    assert!(protocol
        .handle_line(r#"{"id":8,"method":"unknown/request","params":{}}"#)
        .is_err());
}
