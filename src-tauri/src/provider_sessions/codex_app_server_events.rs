use super::*;
use std::collections::HashSet;

#[derive(Default)]
pub struct CodexAppServerEventAdapter {
    agent_delta_items: HashSet<String>,
}

impl CodexAppServerEventAdapter {
    pub fn normalize_notification(
        &mut self,
        run_id: &str,
        tab_id: &str,
        method: &str,
        params: &serde_json::Value,
    ) -> Option<ProviderSessionEvent> {
        let mut event = match method {
            "item/agentMessage/delta" => {
                let text = first_string_field(params, &["delta"])?;
                let item_id = first_string_field(params, &["itemId", "item_id"]);
                if let Some(item_id) = item_id.as_ref() {
                    self.agent_delta_items.insert(item_id.clone());
                }
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    ProviderSessionEventKind::TextDelta,
                    Some(text),
                    Some(method.to_string()),
                );
                event.item_id = item_id;
                event
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" | "item/plan/delta" => {
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    ProviderSessionEventKind::Thinking,
                    first_string_field(params, &["delta"]),
                    Some(method.to_string()),
                );
                event.item_id = first_string_field(params, &["itemId", "item_id"]);
                event
            }
            "item/commandExecution/outputDelta" | "item/commandExecution/terminalInteraction" => {
                codex_app_server_delta_event(
                    run_id,
                    tab_id,
                    method,
                    params,
                    ProviderSessionEventKind::Command,
                    "command_execution",
                )
            }
            "item/fileChange/outputDelta" | "item/fileChange/patchUpdated" => {
                codex_app_server_delta_event(
                    run_id,
                    tab_id,
                    method,
                    params,
                    ProviderSessionEventKind::FileChange,
                    "file_change",
                )
            }
            "item/mcpToolCall/progress" => {
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    ProviderSessionEventKind::McpTool,
                    first_string_field(params, &["message"]),
                    Some(method.to_string()),
                );
                event.item_id = first_string_field(params, &["itemId", "item_id"]);
                event.tool_call_id = event.item_id.clone();
                event
            }
            "item/started" | "item/completed" => {
                let item = params.get("item")?.as_object()?;
                let item_id = first_string_field_from_map(item, &["id", "itemId", "item_id"]);
                let item_type = item.get("type")?.as_str()?;
                if item_type == "agentMessage" {
                    if method == "item/started" {
                        return None;
                    }
                    let streamed = item_id
                        .as_ref()
                        .is_some_and(|item_id| self.agent_delta_items.remove(item_id));
                    if streamed {
                        return None;
                    }
                }
                normalize_codex_app_server_item(run_id, tab_id, method, params, item, item_type)
            }
            "thread/tokenUsage/updated" => {
                let usage = params
                    .get("tokenUsage")
                    .and_then(|usage| usage.get("total"))
                    .unwrap_or(params);
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    ProviderSessionEventKind::Raw,
                    None,
                    Some(method.to_string()),
                );
                apply_provider_usage(&mut event, usage);
                event
            }
            "turn/completed" => {
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("failed");
                let error = params
                    .get("turn")
                    .and_then(|turn| turn.get("error"))
                    .filter(|error| !error.is_null())
                    .and_then(|error| {
                        first_string_field(error, &["message", "detail"])
                            .or_else(|| serde_json::to_string(error).ok())
                    });
                let mut event = provider_event(
                    ProviderId::CodexCli,
                    run_id,
                    tab_id,
                    if status == "failed" {
                        ProviderSessionEventKind::Failed
                    } else if status == "interrupted" {
                        ProviderSessionEventKind::Aborted
                    } else {
                        ProviderSessionEventKind::Raw
                    },
                    error.clone(),
                    Some(method.to_string()),
                );
                event.error = error;
                event.status = provider_status_from_value(params.get("turn").unwrap_or(params))
                    .or(event.status);
                event
            }
            _ => provider_event(
                ProviderId::CodexCli,
                run_id,
                tab_id,
                ProviderSessionEventKind::Raw,
                None,
                Some(method.to_string()),
            ),
        };

        event.protocol = Some("codex-app-server".to_string());
        event.turn_id = first_string_field(params, &["turnId", "turn_id"])
            .or_else(|| {
                params
                    .get("turn")
                    .and_then(|turn| first_string_field(turn, &["id"]))
            })
            .or(event.turn_id);
        event.provider_conversation_id = first_string_field(params, &["threadId", "thread_id"])
            .or(event.provider_conversation_id);
        event.raw_reference = serde_json::to_vec(&serde_json::json!({
            "method": method,
            "params": params,
        }))
        .ok()
        .map(|bytes| content_reference(&bytes, true));
        Some(event)
    }
}

fn codex_app_server_delta_event(
    run_id: &str,
    tab_id: &str,
    method: &str,
    params: &serde_json::Value,
    kind: ProviderSessionEventKind,
    tool_name: &str,
) -> ProviderSessionEvent {
    let mut event = provider_event(
        ProviderId::CodexCli,
        run_id,
        tab_id,
        kind,
        None,
        Some(method.to_string()),
    );
    event.item_id = first_string_field(params, &["itemId", "item_id"]);
    event.tool_call_id = event.item_id.clone();
    event.tool_name = Some(tool_name.to_string());
    event.tool_result = params
        .get("delta")
        .or_else(|| params.get("patch"))
        .or_else(|| params.get("stdin"))
        .and_then(json_content_reference);
    event
}

fn normalize_codex_app_server_item(
    run_id: &str,
    tab_id: &str,
    method: &str,
    params: &serde_json::Value,
    item: &serde_json::Map<String, serde_json::Value>,
    item_type: &str,
) -> ProviderSessionEvent {
    let (kind, text) = match item_type {
        "agentMessage" => (
            ProviderSessionEventKind::Text,
            first_string_field_from_map(item, &["text"]),
        ),
        "reasoning" | "plan" => (ProviderSessionEventKind::Thinking, None),
        "commandExecution" => (
            ProviderSessionEventKind::Command,
            first_string_field_from_map(item, &["command"]),
        ),
        "fileChange" => (
            ProviderSessionEventKind::FileChange,
            first_string_field_from_map(item, &["path"]),
        ),
        "mcpToolCall" => (
            ProviderSessionEventKind::McpTool,
            summarize_codex_app_server_item(item, item_type),
        ),
        "collabAgentToolCall" | "subAgentActivity" => (
            ProviderSessionEventKind::Subagent,
            summarize_codex_app_server_item(item, item_type),
        ),
        "dynamicToolCall" | "webSearch" | "imageView" | "imageGeneration" | "sleep" => (
            ProviderSessionEventKind::Tool,
            summarize_codex_app_server_item(item, item_type),
        ),
        _ => (
            ProviderSessionEventKind::Raw,
            summarize_codex_app_server_item(item, item_type),
        ),
    };
    let mut event = provider_event(
        ProviderId::CodexCli,
        run_id,
        tab_id,
        kind,
        text,
        Some(format!("{method}/{item_type}")),
    );
    event.item_id = first_string_field_from_map(item, &["id", "itemId", "item_id"]);
    event.status = if method == "item/completed" {
        Some(ProviderEventStatus::Completed)
    } else {
        Some(ProviderEventStatus::Started)
    };
    event.status =
        provider_status_from_value(&serde_json::Value::Object(item.clone())).or(event.status);
    if matches!(
        event.kind,
        ProviderSessionEventKind::Tool
            | ProviderSessionEventKind::FileChange
            | ProviderSessionEventKind::Command
            | ProviderSessionEventKind::McpTool
            | ProviderSessionEventKind::Subagent
    ) {
        event.tool_call_id = event.item_id.clone();
        event.tool_name = codex_app_server_tool_name(item_type, item);
        event.tool_arguments = first_value_from_map(
            item,
            &[
                "arguments",
                "command",
                "changes",
                "prompt",
                "query",
                "path",
                "revisedPrompt",
            ],
        )
        .and_then(json_content_reference);
        event.tool_result = first_value_from_map(
            item,
            &[
                "result",
                "aggregatedOutput",
                "contentItems",
                "savedPath",
                "results",
            ],
        )
        .and_then(json_content_reference);
    }
    if event.kind == ProviderSessionEventKind::Subagent {
        event.subagent_id =
            first_string_field_from_map(item, &["agentThreadId", "subagentId", "agentId"]).or_else(
                || {
                    item.get("receiverThreadIds")
                        .and_then(serde_json::Value::as_array)
                        .and_then(|ids| ids.first())
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                },
            );
        event.parent_subagent_id =
            first_string_field_from_map(item, &["senderThreadId", "parentThreadId"])
                .or_else(|| first_string_field(params, &["threadId", "thread_id"]));
    }
    if event.status == Some(ProviderEventStatus::Failed) {
        event.error = first_value_from_map(item, &["error"]).and_then(|error| {
            first_string_field(error, &["message", "detail"])
                .or_else(|| serde_json::to_string(error).ok())
        });
    }
    event
}

fn summarize_codex_app_server_item(
    item: &serde_json::Map<String, serde_json::Value>,
    item_type: &str,
) -> Option<String> {
    if item_type == "mcpToolCall" {
        if let (Some(server), Some(tool)) = (
            first_string_field_from_map(item, &["server"]),
            first_string_field_from_map(item, &["tool"]),
        ) {
            return Some(format!("mcp__{server}__{tool}"));
        }
    }
    first_string_field_from_map(
        item,
        &[
            "command",
            "savedPath",
            "path",
            "query",
            "tool",
            "name",
            "agentPath",
            "result",
            "type",
        ],
    )
}

fn codex_app_server_tool_name(
    item_type: &str,
    item: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    if item_type == "mcpToolCall" {
        return summarize_codex_app_server_item(item, item_type);
    }
    first_string_field_from_map(item, &["tool", "name"]).or_else(|| {
        Some(
            match item_type {
                "commandExecution" => "command_execution",
                "fileChange" => "file_change",
                "subAgentActivity" => "subagent_activity",
                "webSearch" => "web_search",
                "imageView" => "image_view",
                "imageGeneration" => "image_generation",
                other => other,
            }
            .to_string(),
        )
    })
}
