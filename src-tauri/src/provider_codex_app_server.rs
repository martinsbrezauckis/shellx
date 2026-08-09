//! Codex app-server JSONL protocol state machine.
//!
//! The existing provider runner is a one-shot process supervisor. Codex
//! app-server keeps stdin open and requires an ordered initialize/thread/turn
//! exchange, so its wire protocol lives here instead of being approximated by
//! the `codex exec --json` parser. The process supervisor can consume these
//! actions once bidirectional transport and approval routing are wired.

use crate::provider_adapters::ProviderPermissionMode;
use serde_json::{json, Value};

const INITIALIZE_REQUEST_ID: i64 = 1;
const THREAD_REQUEST_ID: i64 = 2;
const TURN_REQUEST_ID: i64 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexAppServerResume {
    Fresh,
    ThreadId(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexAppServerConfig {
    pub cwd: String,
    pub prompt: String,
    pub persist_session: bool,
    pub permission_mode: ProviderPermissionMode,
    pub resume: CodexAppServerResume,
    pub developer_instructions: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexAppServerAction {
    Send(Value),
    ConversationId(String),
    TurnId(String),
    Notification {
        method: String,
        params: Value,
    },
    ApprovalRequired {
        request_id: Value,
        method: String,
        params: Value,
    },
    Terminal(CodexAppServerTerminal),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexAppServerTerminal {
    pub completed: bool,
    pub interrupted: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexAppServerStage {
    Created,
    AwaitingInitialize,
    AwaitingThread,
    AwaitingTurn,
    Streaming,
    Terminal,
}

#[derive(Clone, Debug)]
pub struct CodexAppServerProtocol {
    config: CodexAppServerConfig,
    stage: CodexAppServerStage,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

impl CodexAppServerProtocol {
    pub fn new(config: CodexAppServerConfig) -> Result<Self, String> {
        if config.cwd.trim().is_empty() {
            return Err("Codex app-server cwd is empty".to_string());
        }
        if config.prompt.trim().is_empty() {
            return Err("Codex app-server prompt is empty".to_string());
        }
        if let CodexAppServerResume::ThreadId(thread_id) = &config.resume {
            if thread_id.trim().is_empty() {
                return Err("Codex app-server resume thread id is empty".to_string());
            }
        }
        Ok(Self {
            config,
            stage: CodexAppServerStage::Created,
            thread_id: None,
            turn_id: None,
        })
    }

    pub fn start(&mut self) -> Result<Value, String> {
        if self.stage != CodexAppServerStage::Created {
            return Err("Codex app-server protocol already started".to_string());
        }
        self.stage = CodexAppServerStage::AwaitingInitialize;
        Ok(json!({
            "id": INITIALIZE_REQUEST_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "shellx",
                    "title": "ShellX",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": false
                }
            }
        }))
    }

    pub fn handle_line(&mut self, line: &str) -> Result<Vec<CodexAppServerAction>, String> {
        let value: Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("invalid Codex app-server JSONL: {error}"))?;
        let object = value
            .as_object()
            .ok_or_else(|| "Codex app-server message is not an object".to_string())?;

        if object.contains_key("id") && object.contains_key("method") {
            return self.handle_server_request(&value);
        }
        if object.contains_key("id") {
            return self.handle_response(&value);
        }
        if object.contains_key("method") {
            return self.handle_notification(&value);
        }
        Err("Codex app-server message has no id or method".to_string())
    }

    fn handle_response(&mut self, value: &Value) -> Result<Vec<CodexAppServerAction>, String> {
        let id = value
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Codex app-server response id is not an integer".to_string())?;
        if let Some(error) = value.get("error") {
            let message = rpc_error_message(error);
            self.stage = CodexAppServerStage::Terminal;
            return Ok(vec![CodexAppServerAction::Terminal(
                CodexAppServerTerminal {
                    completed: false,
                    interrupted: false,
                    error: Some(message),
                },
            )]);
        }
        let result = value
            .get("result")
            .ok_or_else(|| format!("Codex app-server response {id} has no result"))?;

        match (self.stage, id) {
            (CodexAppServerStage::AwaitingInitialize, INITIALIZE_REQUEST_ID) => {
                self.stage = CodexAppServerStage::AwaitingThread;
                Ok(vec![
                    CodexAppServerAction::Send(json!({
                        "method": "initialized",
                        "params": {}
                    })),
                    CodexAppServerAction::Send(self.thread_request()),
                ])
            }
            (CodexAppServerStage::AwaitingThread, THREAD_REQUEST_ID) => {
                let thread_id = required_nested_string(result, &["thread", "id"], "thread id")?;
                self.thread_id = Some(thread_id.clone());
                self.stage = CodexAppServerStage::AwaitingTurn;
                Ok(vec![
                    CodexAppServerAction::ConversationId(thread_id.clone()),
                    CodexAppServerAction::Send(self.turn_request(&thread_id)),
                ])
            }
            (CodexAppServerStage::AwaitingTurn, TURN_REQUEST_ID) => {
                let turn_id = required_nested_string(result, &["turn", "id"], "turn id")?;
                self.turn_id = Some(turn_id.clone());
                self.stage = CodexAppServerStage::Streaming;
                Ok(vec![CodexAppServerAction::TurnId(turn_id)])
            }
            _ => Err(format!(
                "unexpected Codex app-server response id {id} while {:?}",
                self.stage
            )),
        }
    }

    fn handle_server_request(&self, value: &Value) -> Result<Vec<CodexAppServerAction>, String> {
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex app-server request method is missing".to_string())?;
        let request_id = value
            .get("id")
            .cloned()
            .ok_or_else(|| "Codex app-server request id is missing".to_string())?;
        let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
        if is_approval_method(method) {
            return Ok(vec![CodexAppServerAction::ApprovalRequired {
                request_id,
                method: method.to_string(),
                params,
            }]);
        }
        Err(format!(
            "unsupported Codex app-server request method: {method}"
        ))
    }

    fn handle_notification(&mut self, value: &Value) -> Result<Vec<CodexAppServerAction>, String> {
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex app-server notification method is missing".to_string())?;
        let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
        let mut actions = Vec::new();

        if method == "thread/started" {
            if let Some(thread_id) = nested_string(&params, &["thread", "id"]) {
                self.thread_id = Some(thread_id.clone());
                actions.push(CodexAppServerAction::ConversationId(thread_id));
            }
        }
        if method == "turn/started" {
            if let Some(turn_id) = nested_string(&params, &["turn", "id"]) {
                self.turn_id = Some(turn_id.clone());
                actions.push(CodexAppServerAction::TurnId(turn_id));
            }
        }

        actions.push(CodexAppServerAction::Notification {
            method: method.to_string(),
            params: params.clone(),
        });

        if method == "turn/completed" {
            let status =
                nested_string(&params, &["turn", "status"]).unwrap_or_else(|| "failed".to_string());
            let error = nested_value(&params, &["turn", "error"])
                .filter(|value| !value.is_null())
                .map(rpc_error_message);
            self.stage = CodexAppServerStage::Terminal;
            actions.push(CodexAppServerAction::Terminal(CodexAppServerTerminal {
                completed: status == "completed",
                interrupted: status == "interrupted",
                error: if status == "completed" {
                    None
                } else {
                    error.or_else(|| Some(format!("Codex turn {status}")))
                },
            }));
        }
        Ok(actions)
    }

    fn thread_request(&self) -> Value {
        let (approval_policy, sandbox) = permission_policy(&self.config.permission_mode);
        let mut params = json!({
            "cwd": self.config.cwd,
            "approvalPolicy": approval_policy,
            "sandbox": sandbox
        });
        if let Some(instructions) = self
            .config
            .developer_instructions
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            params["developerInstructions"] = Value::String(instructions.to_string());
        }
        match &self.config.resume {
            CodexAppServerResume::Fresh => {
                params["ephemeral"] = Value::Bool(!self.config.persist_session);
                json!({
                    "id": THREAD_REQUEST_ID,
                    "method": "thread/start",
                    "params": params
                })
            }
            CodexAppServerResume::ThreadId(thread_id) => {
                params["threadId"] = Value::String(thread_id.clone());
                json!({
                    "id": THREAD_REQUEST_ID,
                    "method": "thread/resume",
                    "params": params
                })
            }
        }
    }

    fn turn_request(&self, thread_id: &str) -> Value {
        json!({
            "id": TURN_REQUEST_ID,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{
                    "type": "text",
                    "text": self.config.prompt
                }]
            }
        })
    }
}

fn permission_policy(mode: &ProviderPermissionMode) -> (&'static str, &'static str) {
    match mode {
        ProviderPermissionMode::BypassPermissions => ("never", "danger-full-access"),
        ProviderPermissionMode::ReadOnly => ("never", "read-only"),
        ProviderPermissionMode::Default => ("untrusted", "workspace-write"),
        ProviderPermissionMode::AcceptEdits => ("never", "workspace-write"),
    }
}

fn is_approval_method(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "execCommandApproval"
            | "applyPatchApproval"
    )
}

fn nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, key| current.get(key))
}

fn nested_string(value: &Value, path: &[&str]) -> Option<String> {
    nested_value(value, path)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn required_nested_string(value: &Value, path: &[&str], label: &str) -> Result<String, String> {
    nested_string(value, path)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Codex app-server response is missing {label}"))
}

fn rpc_error_message(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
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
}
