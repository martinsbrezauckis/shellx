//! Bridge from task-owned bindings to existing Grok ACP sessions.

use std::sync::Arc;

use crate::acp::SessionRegistry;
use crate::task_execution_runtime::{
    StructuredNoTaskStartReason, TaskDispatchObservation, TaskExecutionIdentity,
    TaskProviderDispatchPlan,
};
use crate::task_provider_fallback::ModelSelection;

use super::{
    TaskGrokAcpEventBuffer, TaskGrokAcpLifecycleEvent, TaskProviderAbortOutcome,
    TaskProviderDispatchBinding, TaskProviderDispatchBindingError,
};

/// Concrete bridge for a Grok ACP session that central wiring has already
/// created through the normal fresh-session initializer. It calls the existing
/// ACP prompt API only; it never spawns Grok, configures a path, or inspects
/// auth state.
#[derive(Clone)]
pub(crate) struct TaskGrokAcpRuntime {
    registry: Arc<SessionRegistry>,
}

impl TaskGrokAcpRuntime {
    pub(crate) fn new(registry: Arc<SessionRegistry>) -> Self {
        Self { registry }
    }

    /// The selected plan is bound to a normal, already-started fresh Grok
    /// session. A missing/non-live session proves this adapter did not write a
    /// prompt, so it is the one safe dispatch-time pre-effect rejection.
    pub(crate) async fn dispatch(
        &self,
        dispatch: TaskProviderDispatchPlan,
        binding: &TaskProviderDispatchBinding,
        event_buffer: TaskGrokAcpEventBuffer,
    ) -> Result<TaskGrokAcpDispatch, TaskProviderDispatchBindingError> {
        binding.verify_dispatch_plan(&dispatch)?;
        if dispatch.candidate().provider_id != "grok" {
            return Err(TaskProviderDispatchBindingError::WrongRuntimeForProvider);
        }
        if !matches!(dispatch.candidate().model, ModelSelection::ProviderDefault) {
            return Err(TaskProviderDispatchBindingError::VerifiedModelNotMapped);
        }
        if event_buffer.task_tab_id() != binding.task_tab_id() {
            return Err(TaskProviderDispatchBindingError::DispatchPlanMismatch);
        }
        let Some(session) = self.registry.get_existing(binding.task_tab_id()).await else {
            return Ok(TaskGrokAcpDispatch::NoTaskStarted {
                observation: TaskDispatchObservation::StructuredRejectedNoTaskStarted {
                    reason: StructuredNoTaskStartReason::Unavailable,
                    evidence_reference: grok_no_start_evidence(dispatch.identity()),
                },
            });
        };
        let mut session = session.lock().await;
        if !session.has_active_child() {
            return Ok(TaskGrokAcpDispatch::NoTaskStarted {
                observation: TaskDispatchObservation::StructuredRejectedNoTaskStarted {
                    reason: StructuredNoTaskStartReason::Unavailable,
                    evidence_reference: grok_no_start_evidence(dispatch.identity()),
                },
            });
        }

        match session.initiate_and_send_prompt(&binding.instruction).await {
            Ok(pending) => Ok(TaskGrokAcpDispatch::Accepted {
                observation: TaskDispatchObservation::Accepted {
                    evidence_reference: format!(
                        "task-grok-acp:{}:prompt:{}",
                        binding.task_tab_id(),
                        pending.id()
                    ),
                },
                handle: TaskGrokAcpRunHandle {
                    task_tab_id: binding.task_tab_id().to_string(),
                    event_buffer,
                },
            }),
            // ACP's public error is untyped. A pipe can report failure after a
            // partial write, so it cannot authorize a second provider.
            Err(_) => Ok(TaskGrokAcpDispatch::Ambiguous {
                observation: TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
                    evidence_reference: grok_ambiguous_evidence(dispatch.identity()),
                },
            }),
        }
    }

    /// Abort an already receipted Grok Task run. Task tabs are unique per
    /// attempt, so this cannot cancel an operator's unrelated conversation.
    pub(crate) async fn abort_after_receipt(
        &self,
        handle: &TaskGrokAcpRunHandle,
    ) -> TaskProviderAbortOutcome {
        let Some(session) = self.registry.get_existing(&handle.task_tab_id).await else {
            return TaskProviderAbortOutcome::AlreadyTerminal;
        };
        let outcome = match session.lock().await.abort_session().await {
            Ok(()) => TaskProviderAbortOutcome::CancellationRequested,
            Err(_) => TaskProviderAbortOutcome::Uncertain,
        };
        outcome
    }
}

#[derive(Clone)]
pub(crate) struct TaskGrokAcpRunHandle {
    task_tab_id: String,
    event_buffer: TaskGrokAcpEventBuffer,
}

impl TaskGrokAcpRunHandle {
    pub(crate) fn task_tab_id(&self) -> &str {
        &self.task_tab_id
    }

    pub(crate) fn drain_events(&self) -> Vec<TaskGrokAcpLifecycleEvent> {
        self.event_buffer.drain()
    }
}

pub(crate) enum TaskGrokAcpDispatch {
    Accepted {
        observation: TaskDispatchObservation,
        handle: TaskGrokAcpRunHandle,
    },
    NoTaskStarted {
        observation: TaskDispatchObservation,
    },
    Ambiguous {
        observation: TaskDispatchObservation,
    },
}

fn grok_no_start_evidence(identity: &TaskExecutionIdentity) -> String {
    format!(
        "task-grok-acp:{}:not-ready",
        super::task_runtime_tab_id(identity)
    )
}

fn grok_ambiguous_evidence(identity: &TaskExecutionIdentity) -> String {
    format!(
        "task-grok-acp:{}:dispatch-uncertain",
        super::task_runtime_tab_id(identity)
    )
}
