//! Output-free lifecycle projections for provider Task dispatch.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::provider_adapters::ProviderId;
use crate::provider_sessions::{ProviderSessionEvent, ProviderSessionEventKind};

use super::{bounded, TaskProviderDispatchBindingError, TASK_RUNTIME_EVENT_BUFFER_LIMIT};

/// A stripped provider lifecycle event. It contains enough data for
/// `TaskExecutionRuntime::observe_provider_session_event` to make exactly the
/// same classification as the normal provider stream, but never retains output
/// text, tool arguments/results, artifacts, raw JSON, or provider diagnostics.
#[derive(Clone, Debug)]
pub(crate) struct TaskProviderLifecycleEvent {
    event_id: String,
    run_id: String,
    tab_id: String,
    provider_id: ProviderId,
    kind: ProviderSessionEventKind,
    status: Option<crate::provider_sessions::ProviderEventStatus>,
    had_text: bool,
}

impl TaskProviderLifecycleEvent {
    pub(crate) fn from_provider_event(event: &ProviderSessionEvent) -> Option<Self> {
        (bounded(&event.event_id) && bounded(&event.run_id) && bounded(&event.tab_id)).then(|| {
            Self {
                event_id: event.event_id.clone(),
                run_id: event.run_id.clone(),
                tab_id: event.tab_id.clone(),
                provider_id: event.provider_id,
                kind: event.kind.clone(),
                status: event.status.clone(),
                had_text: event
                    .text
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty()),
            }
        })
    }

    /// Recreate the minimum trusted shape consumed by the existing task event
    /// classifier. `text` is a marker only; it is never provider output.
    pub(crate) fn into_runtime_event(self) -> ProviderSessionEvent {
        ProviderSessionEvent {
            schema_version: 1,
            event_id: self.event_id,
            sequence: 0,
            occurred_at_ms: 0,
            run_id: self.run_id,
            tab_id: self.tab_id,
            provider_id: self.provider_id,
            kind: self.kind,
            status: self.status,
            turn_id: None,
            item_id: None,
            parent_item_id: None,
            tool_call_id: None,
            tool_name: None,
            tool_arguments: None,
            tool_result: None,
            subagent_id: None,
            parent_subagent_id: None,
            model: None,
            protocol: None,
            protocol_version: None,
            binary_version: None,
            capabilities: Vec::new(),
            target: None,
            text: self.had_text.then(|| "activity".to_string()),
            raw_type: None,
            exit_code: None,
            error: None,
            provider_conversation_id: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            usage: None,
            artifacts: Vec::new(),
            raw_reference: None,
        }
    }
}

/// A bounded, task-owned view of normal provider events. The external provider
/// emitter continues to forward original payloads to normal ShellX UI/debug
/// channels; only this projected copy is available to Tasks.
#[derive(Clone)]
pub(crate) struct TaskProviderEventBuffer {
    task_tab_id: String,
    provider_id: ProviderId,
    bound_run_id: Arc<Mutex<Option<String>>>,
    events: Arc<Mutex<VecDeque<TaskProviderLifecycleEvent>>>,
}

impl TaskProviderEventBuffer {
    pub(super) fn new(task_tab_id: String, provider_id: ProviderId) -> Self {
        Self {
            task_tab_id,
            provider_id,
            bound_run_id: Arc::new(Mutex::new(None)),
            events: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    /// Project one normal provider event without retaining provider content.
    pub(crate) fn observe_provider_event(&self, event: &ProviderSessionEvent) {
        if event.tab_id != self.task_tab_id || event.provider_id != self.provider_id {
            return;
        }
        let Some(projected) = TaskProviderLifecycleEvent::from_provider_event(event) else {
            return;
        };
        let bound = self
            .bound_run_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if bound
            .as_deref()
            .is_some_and(|run_id| run_id != projected.run_id)
        {
            return;
        }
        drop(bound);
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if events.len() == TASK_RUNTIME_EVENT_BUFFER_LIMIT {
            events.pop_front();
        }
        events.push_back(projected);
    }

    pub(super) fn bind_run(&self, run_id: &str) {
        let mut bound = self
            .bound_run_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *bound = Some(run_id.to_string());
        drop(bound);
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        events.retain(|event| event.run_id == run_id);
    }

    pub(crate) fn drain(&self) -> Vec<TaskProviderLifecycleEvent> {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        events.drain(..).collect()
    }
}

/// Task-owned, output-free projection of a Grok ACP lifecycle notification.
/// The central ACP event fan-out registers this buffer before sending the
/// prompt, using the deterministic task tab ID. It must call
/// [`TaskGrokAcpEventBuffer::observe_payload`] only for that exact tagged tab.
#[derive(Clone, Debug)]
pub(crate) struct TaskGrokAcpLifecycleEvent {
    event_id: u64,
    kind: TaskGrokAcpLifecycleKind,
}

#[derive(Clone, Copy, Debug)]
enum TaskGrokAcpLifecycleKind {
    ToolOrApproval,
    FirstTaskContent,
    Running,
    Terminal(TaskGrokAcpTerminalKind),
}

#[derive(Clone, Copy, Debug)]
enum TaskGrokAcpTerminalKind {
    Succeeded,
    Cancelled,
    Failed,
    Unknown,
}

impl TaskGrokAcpLifecycleEvent {
    /// Recreate only the structured fields consumed by the existing Grok
    /// runtime classifier. The sentinel text is not provider output.
    pub(crate) fn into_runtime_payload(self, task_tab_id: &str) -> (serde_json::Value, String) {
        let payload = match self.kind {
            TaskGrokAcpLifecycleKind::ToolOrApproval => serde_json::json!({
                "method": "session/update",
                "params": { "update": { "sessionUpdate": "tool_call_update" } }
            }),
            TaskGrokAcpLifecycleKind::FirstTaskContent => serde_json::json!({
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "text": "activity" }
                    }
                }
            }),
            TaskGrokAcpLifecycleKind::Running => serde_json::json!({
                "method": "session/update",
                "params": { "update": { "sessionUpdate": "agent_thought_chunk" } }
            }),
            TaskGrokAcpLifecycleKind::Terminal(kind) => {
                let stop_reason = match kind {
                    TaskGrokAcpTerminalKind::Succeeded => "completed",
                    TaskGrokAcpTerminalKind::Cancelled => "cancelled",
                    TaskGrokAcpTerminalKind::Failed => "failed",
                    TaskGrokAcpTerminalKind::Unknown => "unknown",
                };
                serde_json::json!({
                    "method": "_x.ai/session/prompt_complete",
                    "params": { "stopReason": stop_reason }
                })
            }
        };
        (
            payload,
            format!("task-grok-acp:{task_tab_id}:event:{}", self.event_id),
        )
    }
}

/// Bounded task-owned Grok event projection. Unlike the normal ACP event
/// stream, this buffer does not retain a raw JSON payload or any text. It is
/// therefore safe to hand its events to Task receipt transition logic.
#[derive(Clone)]
pub(crate) struct TaskGrokAcpEventBuffer {
    task_tab_id: String,
    next_event_id: Arc<AtomicU64>,
    events: Arc<Mutex<VecDeque<TaskGrokAcpLifecycleEvent>>>,
}

impl TaskGrokAcpEventBuffer {
    pub(crate) fn new(task_tab_id: String) -> Result<Self, TaskProviderDispatchBindingError> {
        bounded(&task_tab_id)
            .then_some(Self {
                task_tab_id,
                next_event_id: Arc::new(AtomicU64::new(0)),
                events: Arc::new(Mutex::new(VecDeque::new())),
            })
            .ok_or(TaskProviderDispatchBindingError::DispatchPlanMismatch)
    }

    pub(crate) fn task_tab_id(&self) -> &str {
        &self.task_tab_id
    }

    /// Project one tagged ACP notification. The caller must use the normal ACP
    /// event envelope's `_meta.tabId` routing and pass payloads only for this
    /// task tab; any other tab is rejected by the explicit parameter.
    pub(crate) fn observe_payload(&self, tagged_tab_id: &str, payload: &serde_json::Value) {
        if tagged_tab_id != self.task_tab_id {
            return;
        }
        let Some(kind) = grok_lifecycle_kind(payload) else {
            return;
        };
        let event = TaskGrokAcpLifecycleEvent {
            event_id: self.next_event_id.fetch_add(1, Ordering::Relaxed) + 1,
            kind,
        };
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if events.len() == TASK_RUNTIME_EVENT_BUFFER_LIMIT {
            events.pop_front();
        }
        events.push_back(event);
    }

    pub(crate) fn drain(&self) -> Vec<TaskGrokAcpLifecycleEvent> {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        events.drain(..).collect()
    }
}

fn grok_lifecycle_kind(payload: &serde_json::Value) -> Option<TaskGrokAcpLifecycleKind> {
    let method = payload.get("method")?.as_str()?;
    let params = payload.get("params").unwrap_or(&serde_json::Value::Null);
    match method {
        "session/update" => {
            let update = params.get("update")?;
            match update.get("sessionUpdate")?.as_str()? {
                "tool_call_update" => Some(TaskGrokAcpLifecycleKind::ToolOrApproval),
                "agent_message_chunk"
                    if update
                        .get("contentPresent")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or_else(|| {
                            update
                                .get("content")
                                .and_then(|content| content.get("text"))
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|text| !text.trim().is_empty())
                        }) =>
                {
                    Some(TaskGrokAcpLifecycleKind::FirstTaskContent)
                }
                "agent_thought_chunk" => Some(TaskGrokAcpLifecycleKind::Running),
                _ => None,
            }
        }
        "session/request_permission"
            if params
                .get("requestId")
                .and_then(serde_json::Value::as_u64)
                .is_some()
                && matches!(
                    params.get("lifecycle").and_then(serde_json::Value::as_str),
                    Some("auto_approved" | "auto_denied" | "awaiting_decision")
                ) =>
        {
            Some(TaskGrokAcpLifecycleKind::ToolOrApproval)
        }
        "_x.ai/session/prompt_complete" => {
            let terminal = match params.get("stopReason").and_then(serde_json::Value::as_str) {
                Some("end_turn" | "completed" | "complete" | "success") => {
                    TaskGrokAcpTerminalKind::Succeeded
                }
                Some("cancelled") => TaskGrokAcpTerminalKind::Cancelled,
                Some("error" | "failed") => TaskGrokAcpTerminalKind::Failed,
                _ => TaskGrokAcpTerminalKind::Unknown,
            };
            Some(TaskGrokAcpLifecycleKind::Terminal(terminal))
        }
        _ => None,
    }
}
