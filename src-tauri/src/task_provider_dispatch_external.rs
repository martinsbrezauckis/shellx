//! Bridge from task-owned bindings to existing external provider sessions.

use std::sync::Arc;

use crate::provider_sessions::{
    start_provider_session, ProviderRunSnapshot, ProviderSessionEmit, ProviderSessionEvent,
    ProviderSessionRegistry,
};
use crate::task_execution_runtime::{
    TaskDispatchObservation, TaskExecutionIdentity, TaskProviderDispatchPlan,
};

use super::{
    TaskProviderAbortOutcome, TaskProviderDispatchBinding, TaskProviderDispatchBindingError,
    TaskProviderEventBuffer, TaskProviderLifecycleEvent,
};

/// Opaque handle for a successfully dispatched normal provider run.
#[derive(Clone)]
pub(crate) struct TaskExternalProviderRunHandle {
    task_tab_id: String,
    run_id: String,
    run_target: crate::provider_sessions::ProviderSessionRunTarget,
    event_buffer: TaskProviderEventBuffer,
}

impl TaskExternalProviderRunHandle {
    pub(crate) fn task_tab_id(&self) -> &str {
        &self.task_tab_id
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn drain_events(&self) -> Vec<TaskProviderLifecycleEvent> {
        self.event_buffer.drain()
    }
}

/// Concrete bridge to the existing normalized Codex, Claude, and Antigravity
/// provider-session runtime. It never calls `Command` or reads authentication
/// state; `start_provider_session` remains the sole launch implementation.
#[derive(Clone)]
pub(crate) struct TaskExternalProviderRuntime {
    registry: Arc<ProviderSessionRegistry>,
    emit: ProviderSessionEmit,
}

impl TaskExternalProviderRuntime {
    pub(crate) fn new(registry: Arc<ProviderSessionRegistry>, emit: ProviderSessionEmit) -> Self {
        Self { registry, emit }
    }

    /// Dispatch the already-persisted plan. Errors returned by the existing
    /// provider runtime are deliberately converted to an ambiguous result: its
    /// public API does not provide typed proof that a prompt was not accepted.
    pub(crate) async fn dispatch(
        &self,
        dispatch: TaskProviderDispatchPlan,
        binding: &TaskProviderDispatchBinding,
    ) -> Result<TaskExternalProviderDispatch, TaskProviderDispatchBindingError> {
        let request = binding.external_start_request(&dispatch)?;
        let event_buffer =
            TaskProviderEventBuffer::new(binding.task_tab_id().to_string(), request.provider_id);
        let buffer_for_emit = event_buffer.clone();
        let downstream_emit = self.emit.clone();
        let task_emit: ProviderSessionEmit = Arc::new(move |kind, payload| {
            if kind == "provider-session-event" {
                if let Ok(event) = serde_json::from_value::<ProviderSessionEvent>(payload.clone()) {
                    buffer_for_emit.observe_provider_event(&event);
                }
            }
            downstream_emit(kind, payload);
        });

        match start_provider_session(self.registry.clone(), request, task_emit).await {
            Ok(run) => {
                // The runtime may emit an early event before returning. Bind it
                // to the accepted run before exposing the handle and discard
                // any event from a stale run that shared this task tab.
                event_buffer.bind_run(&run.run_id);
                Ok(TaskExternalProviderDispatch::Accepted {
                    observation: TaskDispatchObservation::Accepted {
                        evidence_reference: external_start_evidence(&run),
                    },
                    handle: TaskExternalProviderRunHandle {
                        task_tab_id: run.tab_id.clone(),
                        run_id: run.run_id.clone(),
                        run_target: binding.resolved_target.run_target.clone(),
                        event_buffer,
                    },
                })
            }
            // Do not inspect the string. It could be emitted after stdin was
            // written, an SSH connection was lost, or the provider accepted
            // work. Falling back would risk duplicate effects.
            Err(_) => Ok(TaskExternalProviderDispatch::Ambiguous {
                observation: TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
                    evidence_reference: external_dispatch_ambiguous_evidence(dispatch.identity()),
                },
            }),
        }
    }

    /// Execute an already receipted cancellation/timeout request for the exact
    /// provider run and target. The caller persists the terminal transition
    /// before invoking this method; a failed abort must be recorded as an
    /// uncertain cleanup outcome by central wiring.
    pub(crate) async fn abort_after_receipt(
        &self,
        handle: &TaskExternalProviderRunHandle,
    ) -> TaskProviderAbortOutcome {
        match self
            .registry
            .abort_active_child_for_target(
                handle.task_tab_id(),
                Some(handle.run_id()),
                handle.run_target.clone(),
            )
            .await
        {
            Ok(true) => TaskProviderAbortOutcome::CancellationRequested,
            Ok(false) => TaskProviderAbortOutcome::AlreadyTerminal,
            Err(_) => TaskProviderAbortOutcome::Uncertain,
        }
    }

    /// Read the existing normalized runtime's status for exactly this task
    /// run. The coordinator immediately classifies the snapshot and retains
    /// no provider text, diagnostics, conversation identifier, or prompt
    /// preview from it.
    pub(crate) fn active_snapshot(
        &self,
        handle: &TaskExternalProviderRunHandle,
    ) -> Option<ProviderRunSnapshot> {
        self.registry
            .active_run_by_id(handle.task_tab_id(), handle.run_id())
    }
}

/// Dispatch result intentionally separates a known accepted run from an
/// untyped ambiguous failure. Neither contains provider output or error text.
pub(crate) enum TaskExternalProviderDispatch {
    Accepted {
        observation: TaskDispatchObservation,
        handle: TaskExternalProviderRunHandle,
    },
    Ambiguous {
        observation: TaskDispatchObservation,
    },
}

fn external_start_evidence(run: &ProviderRunSnapshot) -> String {
    format!("task-provider-session:{}:started", run.run_id)
}

fn external_dispatch_ambiguous_evidence(identity: &TaskExecutionIdentity) -> String {
    format!(
        "task-provider-dispatch:{}",
        super::task_runtime_tab_id(identity)
    )
}
