//! Async, app-owned coordinator for one claimed ShellX Task occurrence.
//!
//! The foreground service owns durable claiming and final occurrence state.
//! This module owns the bounded path in between: it loads an immutable binding
//! from the same store, insists on a fresh trusted catalogue and resolved
//! connection, persists every runtime decision, and drives ShellX's existing
//! provider-session/Grok runtimes. It creates no provider command, Tokio
//! runtime, thread, detached worker, authentication flow, or second store.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::task_execution_bindings::TaskResolvedExecutionBindings;
use crate::task_execution_runtime::{
    PersistedTaskExecutionAction, TaskDispatchObservation, TaskExecutionIdentity,
    TaskExecutionRuntime, TaskExecutionRuntimeError,
};
use crate::task_execution_store_adapter::{
    TaskExecutionStoreAdapterError, TaskExecutionStoreBinding, TaskStoreReceiptSink,
};
use crate::task_provider_catalog::TaskProviderCatalog;
use crate::task_provider_dispatch::{
    TaskExternalProviderDispatch, TaskExternalProviderRuntime, TaskGrokAcpDispatch,
    TaskGrokAcpEventBuffer, TaskGrokAcpRuntime, TaskGrokSessionStartContext,
    TaskProviderAbortOutcome, TaskProviderDispatchBinding, TaskProviderDispatchBindingError,
    TaskProviderResolvedTarget, TaskProviderRuntimePolicy,
};
use crate::task_store::{TaskStore, TaskStoreError};

use super::{
    TaskForegroundClaim, TaskForegroundExecutionRunner, TaskForegroundRunnerError,
    TaskForegroundRunnerFuture, TaskForegroundRunnerResult,
};

const DEFAULT_RUNTIME_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_RUNTIME_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_ACTIVE_CANCELLATIONS: usize = 8;

type TaskRuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Fresh, authority-owned input for an already claimed occurrence.
///
/// Application wiring must obtain `catalogue` from a new capability scan for
/// the immutable revision environment, then resolve the revision's saved
/// connection (or the trusted local connection) into `resolved_target`. This
/// type intentionally has no prompt, model, credential, provider output, or
/// renderer-supplied execution field.
#[derive(Clone)]
pub(crate) struct TaskRuntimeTrustedInputs {
    catalogue: TaskProviderCatalog,
    resolved_target: TaskProviderResolvedTarget,
    policy: TaskProviderRuntimePolicy,
    bindings: TaskResolvedExecutionBindings,
}

impl TaskRuntimeTrustedInputs {
    pub(crate) fn new(
        catalogue: TaskProviderCatalog,
        resolved_target: TaskProviderResolvedTarget,
        policy: TaskProviderRuntimePolicy,
        bindings: TaskResolvedExecutionBindings,
    ) -> Self {
        Self {
            catalogue,
            resolved_target,
            policy,
            bindings,
        }
    }
}

/// Central app authority seam for fresh catalogue generation and immutable
/// saved/local connection resolution. It must not use task renderer state and
/// must not open a second `TaskStore`.
pub(crate) trait TaskRuntimeTrustResolver: Send + Sync {
    fn resolve_for_claim<'a>(
        &'a self,
        claim: &'a TaskForegroundClaim,
    ) -> TaskRuntimeFuture<'a, Result<TaskRuntimeTrustedInputs, TaskRuntimeCoordinatorError>>;
}

/// Output-free wakeup emitted only after the exact cancellation identity is
/// active. Implementations may refresh UI projections but cannot influence
/// provider routing or retain provider output.
pub(crate) trait TaskRuntimeProgressObserver: Send + Sync {
    fn attempt_active(&self, occurrence_id: &str, attempt_id: &str);
}

struct NoopTaskRuntimeProgressObserver;

impl TaskRuntimeProgressObserver for NoopTaskRuntimeProgressObserver {
    fn attempt_active(&self, _occurrence_id: &str, _attempt_id: &str) {}
}

/// The normal app-layer Grok initializer. It must call ShellX's existing
/// `start_grok_session` route, including its transport, tab-autonomy and
/// tab-bound Host MCP setup, before reporting `Ready`. The starter never
/// writes a task prompt; a rejection therefore proves no task work started.
pub(crate) trait TaskRuntimeGrokSessionStarter: Send + Sync {
    fn prepare_fresh_grok_session<'a>(
        &'a self,
        context: TaskGrokSessionStartContext,
        events: TaskGrokAcpEventBuffer,
    ) -> TaskRuntimeFuture<'a, TaskRuntimeGrokPreparation>;

    /// Release the exact deterministic task tab after the runtime has
    /// durably recorded its terminal/no-start/uncertain decision. Central
    /// wiring must use the same app-owned close path as an interactive tab:
    /// SessionRegistry drop, ACP observer removal, Host-MCP child cleanup and
    /// associated per-tab state cleanup. This coordinator never duplicates
    /// that Tauri-owned lifecycle.
    fn cleanup_task_tab<'a>(
        &'a self,
        task_tab_id: String,
    ) -> TaskRuntimeFuture<'a, Result<(), TaskRuntimeGrokCleanupError>>;
}

/// Closed preparation result. Application code must return `RejectedBeforePrompt`
/// for an initializer failure only when it did not send a task prompt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskRuntimeGrokPreparation {
    Ready,
    /// `cleanup_required` is true only when the normal initializer allocated
    /// a tab slot or observer before failing, and no task prompt was sent.
    RejectedBeforePrompt {
        cleanup_required: bool,
    },
}

/// Bounded cleanup result: implementation diagnostics must stay in normal app
/// logs and never be copied into task receipts or foreground notifications.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskRuntimeGrokCleanupError {
    Failed,
}

/// One app-owned cancellation channel. A request must name both occurrence and
/// attempt, so a stale UI action cannot cancel a later retry for the same task.
#[derive(Default)]
pub(crate) struct TaskRuntimeCancellation {
    state: Mutex<TaskRuntimeCancellationState>,
}

#[derive(Default)]
struct TaskRuntimeCancellationState {
    active: BTreeSet<(String, String)>,
    requested: BTreeSet<(String, String)>,
}

impl TaskRuntimeCancellation {
    pub(crate) fn request(&self, occurrence_id: &str, attempt_id: &str) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = (occurrence_id.to_string(), attempt_id.to_string());
        if state.active.contains(&key) {
            state.requested.insert(key);
            true
        } else {
            false
        }
    }

    fn activate(
        &self,
        identity: &TaskExecutionIdentity,
    ) -> Result<(), TaskRuntimeCoordinatorError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active.len() == MAX_ACTIVE_CANCELLATIONS {
            return Err(TaskRuntimeCoordinatorError::CancellationCapacity);
        }
        let key = (identity.occurrence_id.clone(), identity.attempt_id.clone());
        state.active.insert(key.clone());
        state.requested.remove(&key);
        Ok(())
    }

    fn is_requested(&self, identity: &TaskExecutionIdentity) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .requested
            .contains(&(identity.occurrence_id.clone(), identity.attempt_id.clone()))
    }

    fn deactivate(&self, identity: &TaskExecutionIdentity) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = (identity.occurrence_id.clone(), identity.attempt_id.clone());
        state.active.remove(&key);
        state.requested.remove(&key);
    }
}

/// The coordinator performs its waits on the same Tokio runtime that awaits
/// the foreground service. Tests inject a fake clock; production uses this
/// implementation and no nested or detached runtime is created.
trait TaskRuntimeClock: Send + Sync {
    fn now_ms(&self) -> Result<i64, TaskRuntimeCoordinatorError>;
    fn wait_for_poll<'a>(&'a self) -> TaskRuntimeFuture<'a, ()>;
}

struct AppTaskRuntimeClock {
    poll_interval: Duration,
}

impl TaskRuntimeClock for AppTaskRuntimeClock {
    fn now_ms(&self) -> Result<i64, TaskRuntimeCoordinatorError> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| TaskRuntimeCoordinatorError::ClockUnavailable)?;
        i64::try_from(elapsed.as_millis())
            .map_err(|_| TaskRuntimeCoordinatorError::ClockUnavailable)
    }

    fn wait_for_poll<'a>(&'a self) -> TaskRuntimeFuture<'a, ()> {
        Box::pin(tokio::time::sleep(self.poll_interval))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TaskRuntimeCoordinatorConfig {
    pub poll_interval: Duration,
}

impl Default for TaskRuntimeCoordinatorConfig {
    fn default() -> Self {
        Self {
            poll_interval: DEFAULT_RUNTIME_POLL_INTERVAL,
        }
    }
}

impl TaskRuntimeCoordinatorConfig {
    pub(crate) fn validate(self) -> Result<Self, TaskRuntimeCoordinatorError> {
        if self.poll_interval.is_zero() || self.poll_interval > MAX_RUNTIME_POLL_INTERVAL {
            return Err(TaskRuntimeCoordinatorError::InvalidPollInterval);
        }
        Ok(self)
    }
}

/// Concrete adapter over the existing normalized provider runtimes. The only
/// Grok startup hook remains app-owned because its normal initializer owns
/// Tauri and Host MCP registration.
pub(crate) struct TaskRuntimeProviderDispatcher {
    external: TaskExternalProviderRuntime,
    grok: TaskGrokAcpRuntime,
    grok_starter: Arc<dyn TaskRuntimeGrokSessionStarter>,
}

impl TaskRuntimeProviderDispatcher {
    pub(crate) fn new(
        external: TaskExternalProviderRuntime,
        grok: TaskGrokAcpRuntime,
        grok_starter: Arc<dyn TaskRuntimeGrokSessionStarter>,
    ) -> Self {
        Self {
            external,
            grok,
            grok_starter,
        }
    }

    async fn dispatch(
        &self,
        plan: crate::task_execution_runtime::TaskProviderDispatchPlan,
        binding: &TaskProviderDispatchBinding,
    ) -> Result<TaskRuntimeDispatchResult, TaskRuntimeCoordinatorError> {
        if plan.candidate().provider_id == "grok" {
            let events = TaskGrokAcpEventBuffer::new(binding.task_tab_id().to_string())
                .map_err(TaskRuntimeCoordinatorError::DispatchBinding)?;
            match self
                .grok_starter
                .prepare_fresh_grok_session(binding.grok_session_start_context(), events.clone())
                .await
            {
                TaskRuntimeGrokPreparation::RejectedBeforePrompt { cleanup_required } => {
                    return Ok(TaskRuntimeDispatchResult {
                        observation: TaskDispatchObservation::StructuredRejectedNoTaskStarted {
                            reason: crate::task_execution_runtime::StructuredNoTaskStartReason::Unavailable,
                            evidence_reference: format!(
                                "task-grok-session:{}:unavailable",
                                binding.task_tab_id()
                            ),
                        },
                        active: None,
                        grok_cleanup_task_tab: cleanup_required
                            .then(|| binding.task_tab_id().to_string()),
                    });
                }
                TaskRuntimeGrokPreparation::Ready => {}
            }
            return match self.grok.dispatch(plan, binding, events).await {
                Ok(TaskGrokAcpDispatch::Accepted {
                    observation,
                    handle,
                }) => Ok(TaskRuntimeDispatchResult {
                    observation,
                    active: Some(TaskRuntimeActiveDispatch::Grok(handle)),
                    grok_cleanup_task_tab: Some(binding.task_tab_id().to_string()),
                }),
                Ok(TaskGrokAcpDispatch::NoTaskStarted { observation })
                | Ok(TaskGrokAcpDispatch::Ambiguous { observation }) => {
                    Ok(TaskRuntimeDispatchResult {
                        observation,
                        active: None,
                        grok_cleanup_task_tab: Some(binding.task_tab_id().to_string()),
                    })
                }
                // A Grok dispatch error is not safely classified as
                // pre-effect: startup succeeded and ACP can report an error
                // after a partial prompt write. Persist one explicit unknown
                // verdict, then retire this exact task tab.
                Err(_) => Ok(TaskRuntimeDispatchResult {
                    observation: TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
                        evidence_reference: format!(
                            "task-grok-acp:{}:dispatch-uncertain",
                            binding.task_tab_id()
                        ),
                    },
                    active: None,
                    grok_cleanup_task_tab: Some(binding.task_tab_id().to_string()),
                }),
            };
        }

        match self
            .external
            .dispatch(plan, binding)
            .await
            .map_err(TaskRuntimeCoordinatorError::DispatchBinding)?
        {
            TaskExternalProviderDispatch::Accepted {
                observation,
                handle,
            } => Ok(TaskRuntimeDispatchResult {
                observation,
                active: Some(TaskRuntimeActiveDispatch::External(handle)),
                grok_cleanup_task_tab: None,
            }),
            TaskExternalProviderDispatch::Ambiguous { observation, .. } => {
                Ok(TaskRuntimeDispatchResult {
                    observation,
                    active: None,
                    grok_cleanup_task_tab: None,
                })
            }
        }
    }

    async fn abort_after_receipt(
        &self,
        active: &TaskRuntimeActiveDispatch,
    ) -> TaskProviderAbortOutcome {
        match active {
            TaskRuntimeActiveDispatch::External(handle) => {
                self.external.abort_after_receipt(handle).await
            }
            TaskRuntimeActiveDispatch::Grok(handle) => self.grok.abort_after_receipt(handle).await,
        }
    }

    async fn cleanup_grok_after_receipt(
        &self,
        task_tab_id: Option<String>,
    ) -> Result<(), TaskRuntimeGrokCleanupError> {
        let Some(task_tab_id) = task_tab_id else {
            return Ok(());
        };
        self.grok_starter.cleanup_task_tab(task_tab_id).await
    }

    fn observe_active(
        &self,
        active: &TaskRuntimeActiveDispatch,
        runtime: &mut TaskExecutionRuntime,
        receipts: &mut TaskStoreReceiptSink<'_>,
    ) -> Result<Vec<PersistedTaskExecutionAction>, TaskRuntimeCoordinatorError> {
        let mut actions = Vec::new();
        match active {
            TaskRuntimeActiveDispatch::External(handle) => {
                for event in handle.drain_events() {
                    if let Some(transition) = runtime
                        .observe_provider_session_event(&event.into_runtime_event())
                        .map_err(TaskRuntimeCoordinatorError::Runtime)?
                    {
                        actions.push(
                            transition
                                .persist(receipts)
                                .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                                .into_action(),
                        );
                    }
                }
                // The existing event stream is authoritative, but a current
                // normalized run snapshot closes the small gap where a process
                // exits before its final event reaches the task projection.
                if let Some(snapshot) = self.external.active_snapshot(handle) {
                    if let Some(transition) = runtime
                        .observe_provider_run_snapshot(
                            &snapshot,
                            format!("task-provider-session:{}:snapshot", handle.run_id()),
                        )
                        .map_err(TaskRuntimeCoordinatorError::Runtime)?
                    {
                        actions.push(
                            transition
                                .persist(receipts)
                                .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                                .into_action(),
                        );
                    }
                }
            }
            TaskRuntimeActiveDispatch::Grok(handle) => {
                for event in handle.drain_events() {
                    let (payload, evidence) = event.into_runtime_payload(handle.task_tab_id());
                    if let Some(transition) = runtime
                        .observe_grok_acp_event(&payload, evidence)
                        .map_err(TaskRuntimeCoordinatorError::Runtime)?
                    {
                        actions.push(
                            transition
                                .persist(receipts)
                                .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                                .into_action(),
                        );
                    }
                }
            }
        }
        Ok(actions)
    }
}

enum TaskRuntimeActiveDispatch {
    External(crate::task_provider_dispatch::TaskExternalProviderRunHandle),
    Grok(crate::task_provider_dispatch::TaskGrokAcpRunHandle),
}

struct TaskRuntimeDispatchResult {
    observation: TaskDispatchObservation,
    active: Option<TaskRuntimeActiveDispatch>,
    grok_cleanup_task_tab: Option<String>,
}

/// Owner-bound lease maintenance for one already-claimed occurrence. This is
/// intentionally derived from the persisted claim, not task timeout policy.
struct TaskRuntimeLeaseKeepalive<'store> {
    store: &'store TaskStore,
    occurrence_id: String,
    lease_id: String,
    owner_id: String,
    lease_duration_ms: i64,
    next_heartbeat_at_ms: i64,
}

impl<'store> TaskRuntimeLeaseKeepalive<'store> {
    fn new(claim: &'store TaskForegroundClaim) -> Result<Self, TaskRuntimeCoordinatorError> {
        let lease_duration_ms = claim.lease_duration_ms();
        if lease_duration_ms <= 1 {
            return Err(TaskRuntimeCoordinatorError::InvalidLeaseDuration);
        }
        let claimed_at_ms = claim
            .occurrence()
            .active_lease
            .as_ref()
            .map(|lease| lease.claimed_at_ms)
            .ok_or(TaskRuntimeCoordinatorError::InvalidLeaseDuration)?;
        // A third of the owned lease leaves two recovery opportunities before
        // expiry, including the minimum 1s foreground lease used by tests.
        let cadence_ms = (lease_duration_ms / 3).max(1);
        Ok(Self {
            store: claim.store(),
            occurrence_id: claim.occurrence().occurrence_id.clone(),
            lease_id: claim.lease_id().to_string(),
            owner_id: claim.owner_id().to_string(),
            lease_duration_ms,
            next_heartbeat_at_ms: claimed_at_ms.saturating_add(cadence_ms),
        })
    }

    fn heartbeat_if_due(&mut self, now_ms: i64) -> Result<(), TaskStoreError> {
        if now_ms < self.next_heartbeat_at_ms {
            return Ok(());
        }
        self.store.heartbeat_occurrence(
            &self.occurrence_id,
            &self.lease_id,
            &self.owner_id,
            self.lease_duration_ms,
            now_ms,
        )?;
        self.next_heartbeat_at_ms = now_ms.saturating_add((self.lease_duration_ms / 3).max(1));
        Ok(())
    }
}

/// Async execution runner passed directly to `TaskForegroundService`.
pub(crate) struct TaskRuntimeCoordinator {
    trust_resolver: Arc<dyn TaskRuntimeTrustResolver>,
    dispatcher: TaskRuntimeProviderDispatcher,
    cancellation: Arc<TaskRuntimeCancellation>,
    progress: Arc<dyn TaskRuntimeProgressObserver>,
    clock: Arc<dyn TaskRuntimeClock>,
}

impl TaskRuntimeCoordinator {
    pub(crate) fn new(
        trust_resolver: Arc<dyn TaskRuntimeTrustResolver>,
        dispatcher: TaskRuntimeProviderDispatcher,
        cancellation: Arc<TaskRuntimeCancellation>,
        config: TaskRuntimeCoordinatorConfig,
    ) -> Result<Self, TaskRuntimeCoordinatorError> {
        let config = config.validate()?;
        Ok(Self {
            trust_resolver,
            dispatcher,
            cancellation,
            progress: Arc::new(NoopTaskRuntimeProgressObserver),
            clock: Arc::new(AppTaskRuntimeClock {
                poll_interval: config.poll_interval,
            }),
        })
    }

    pub(crate) fn with_progress_observer(
        mut self,
        progress: Arc<dyn TaskRuntimeProgressObserver>,
    ) -> Self {
        self.progress = progress;
        self
    }

    async fn execute(
        &self,
        claim: TaskForegroundClaim,
    ) -> Result<TaskForegroundRunnerResult, TaskForegroundRunnerError> {
        let result = self.execute_inner(claim).await;
        result.map_err(|error| error.runner_error())
    }

    async fn execute_inner(
        &self,
        claim: TaskForegroundClaim,
    ) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
        // The claim exists before any catalogue scan or provider startup.
        // Keep it owner-bound across every later await; task timeout is a
        // separate policy and does not suspend durable lease ownership.
        let mut lease = TaskRuntimeLeaseKeepalive::new(&claim)?;
        let trusted = self
            .await_with_lease(self.trust_resolver.resolve_for_claim(&claim), &mut lease)
            .await??;
        let now_ms = self.clock.now_ms()?;
        let binding = TaskExecutionStoreBinding::load(
            claim.store(),
            &claim.occurrence().occurrence_id,
            claim.owner_id(),
            &trusted.catalogue,
            now_ms,
        )
        .map_err(TaskRuntimeCoordinatorError::StoreBinding)?;
        let dispatch_binding = TaskProviderDispatchBinding::from_immutable_revision(
            binding.plan(),
            binding.revision(),
            trusted.resolved_target,
            trusted.policy.clone(),
            trusted.bindings.clone(),
        )
        .map_err(TaskRuntimeCoordinatorError::DispatchBinding)?;
        let identity = binding.plan().identity().clone();
        self.cancellation.activate(&identity)?;
        self.progress
            .attempt_active(&identity.occurrence_id, &identity.attempt_id);
        let result = self
            .drive_bound_runtime(
                &claim,
                binding,
                trusted.catalogue,
                dispatch_binding,
                trusted.bindings,
                trusted.policy.shellx_tool_exposure,
                &mut lease,
            )
            .await;
        self.cancellation.deactivate(&identity);
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive_bound_runtime(
        &self,
        claim: &TaskForegroundClaim,
        binding: TaskExecutionStoreBinding,
        catalogue: TaskProviderCatalog,
        dispatch_binding: TaskProviderDispatchBinding,
        execution_bindings: TaskResolvedExecutionBindings,
        shellx_tool_exposure: crate::provider_adapters::ProviderShellxToolExposure,
        lease: &mut TaskRuntimeLeaseKeepalive<'_>,
    ) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
        let timeout_ms = u64::from(binding.revision().draft.timeout_policy.max_run_seconds)
            .checked_mul(1_000)
            .ok_or(TaskRuntimeCoordinatorError::InvalidTimeout)?;
        let started_at_ms = self.clock.now_ms()?;
        let deadline_ms = started_at_ms
            .checked_add(
                i64::try_from(timeout_ms)
                    .map_err(|_| TaskRuntimeCoordinatorError::InvalidTimeout)?,
            )
            .ok_or(TaskRuntimeCoordinatorError::InvalidTimeout)?;
        let mut runtime = TaskExecutionRuntime::new(binding.plan().clone())
            .map_err(TaskRuntimeCoordinatorError::RuntimePlan)?;
        let mut receipts =
            TaskStoreReceiptSink::new(claim.store(), binding.clone(), current_time_ms)
                .map_err(TaskRuntimeCoordinatorError::StoreBinding)?;

        let mut action = runtime
            .begin(format!("task-lease:{}", claim.lease_id()))
            .map_err(TaskRuntimeCoordinatorError::Runtime)?
            .persist(&mut receipts)
            .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
            .into_action();
        let mut active = None;
        let mut grok_cleanup_task_tab = None;

        loop {
            action = match action {
                PersistedTaskExecutionAction::RunPreflight(plan) => {
                    let mut entry = binding
                        .catalogue_entry(&catalogue, plan.candidate().order, self.clock.now_ms()?)
                        .map_err(TaskRuntimeCoordinatorError::StoreBinding)?;
                    execution_bindings.apply_preflight(&mut entry, shellx_tool_exposure);
                    runtime
                        .apply_catalogue_preflight(entry, self.clock.now_ms()?)
                        .map_err(TaskRuntimeCoordinatorError::Runtime)?
                        .persist(&mut receipts)
                        .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                        .into_action()
                }
                PersistedTaskExecutionAction::DispatchProvider(plan) => {
                    let dispatched = self
                        .await_with_lease(
                            Box::pin(self.dispatcher.dispatch(*plan, &dispatch_binding)),
                            lease,
                        )
                        .await??;
                    active = dispatched.active;
                    grok_cleanup_task_tab = dispatched.grok_cleanup_task_tab;
                    let pending = runtime
                        .apply_dispatch_observation(dispatched.observation)
                        .map_err(TaskRuntimeCoordinatorError::Runtime)?;
                    match pending.persist(&mut receipts) {
                        Ok(transition) => transition.into_action(),
                        Err(error) => {
                            // Accepted dispatch is already a possible external
                            // effect. Do not lose its exact handle on receipt
                            // failure: request containment, then surface an
                            // owner-bound OutcomeUnknown through the
                            // foreground service without claiming cleanup was
                            // persisted successfully.
                            if let Some(active_dispatch) = active.as_ref() {
                                let _ = self.dispatcher.abort_after_receipt(active_dispatch).await;
                            }
                            // The receipt did not commit, so there is no
                            // provider terminal to order cleanup after. We
                            // nevertheless contain the deterministic task tab
                            // before handing owner-bound uncertainty to the
                            // foreground service; its terminal occurrence
                            // write remains the source of truth.
                            let _ = self
                                .dispatcher
                                .cleanup_grok_after_receipt(grok_cleanup_task_tab.take())
                                .await;
                            return Err(TaskRuntimeCoordinatorError::StoreBinding(error));
                        }
                    }
                }
                PersistedTaskExecutionAction::CommittedStartRecorded => {
                    let Some(active_dispatch) = active.as_ref() else {
                        return outcome_unknown("task-runtime-missing-active-handle");
                    };
                    return self
                        .wait_for_terminal(
                            &mut runtime,
                            &mut receipts,
                            active_dispatch,
                            lease,
                            deadline_ms,
                            grok_cleanup_task_tab.take(),
                        )
                        .await;
                }
                PersistedTaskExecutionAction::Notify(notification) => {
                    let result =
                        terminal_action(PersistedTaskExecutionAction::Notify(notification))?;
                    return self
                        .cleanup_after_terminal_receipt(result, grok_cleanup_task_tab.take())
                        .await;
                }
            };
        }
    }

    async fn wait_for_terminal(
        &self,
        runtime: &mut TaskExecutionRuntime,
        receipts: &mut TaskStoreReceiptSink<'_>,
        active: &TaskRuntimeActiveDispatch,
        lease: &mut TaskRuntimeLeaseKeepalive<'_>,
        deadline_ms: i64,
        grok_cleanup_task_tab: Option<String>,
    ) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
        loop {
            let identity = runtime.plan().identity();
            let now_ms = self.clock.now_ms()?;
            if let Err(error) = lease.heartbeat_if_due(now_ms) {
                // The current lease can no longer be proven owned. Contain
                // the exact provider handle before returning an explicit
                // owner-bound uncertainty to the foreground service.
                let _ = self.dispatcher.abort_after_receipt(active).await;
                let _ = self
                    .dispatcher
                    .cleanup_grok_after_receipt(grok_cleanup_task_tab)
                    .await;
                return Err(TaskRuntimeCoordinatorError::LeaseHeartbeat(error));
            }
            if self.cancellation.is_requested(identity) {
                let action = runtime
                    .observe_cancellation("task-runtime-cancel-request")
                    .map_err(TaskRuntimeCoordinatorError::Runtime)?
                    .persist(receipts)
                    .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                    .into_action();
                let abort = self.dispatcher.abort_after_receipt(active).await;
                return match abort {
                    TaskProviderAbortOutcome::CancellationRequested
                    | TaskProviderAbortOutcome::AlreadyTerminal => {
                        self.cleanup_after_terminal_receipt(
                            terminal_action(action)?,
                            grok_cleanup_task_tab,
                        )
                        .await
                    }
                    TaskProviderAbortOutcome::Uncertain => {
                        self.cleanup_after_terminal_receipt(
                            outcome_unknown("task-runtime-cancel-uncertain")?,
                            grok_cleanup_task_tab,
                        )
                        .await
                    }
                };
            }
            if now_ms >= deadline_ms {
                let action = runtime
                    .observe_timeout("task-runtime-timeout")
                    .map_err(TaskRuntimeCoordinatorError::Runtime)?
                    .persist(receipts)
                    .map_err(TaskRuntimeCoordinatorError::StoreBinding)?
                    .into_action();
                let abort = self.dispatcher.abort_after_receipt(active).await;
                return match abort {
                    TaskProviderAbortOutcome::Uncertain => {
                        self.cleanup_after_terminal_receipt(
                            outcome_unknown("task-runtime-timeout-uncertain")?,
                            grok_cleanup_task_tab,
                        )
                        .await
                    }
                    TaskProviderAbortOutcome::CancellationRequested
                    | TaskProviderAbortOutcome::AlreadyTerminal => {
                        self.cleanup_after_terminal_receipt(
                            terminal_action(action)?,
                            grok_cleanup_task_tab,
                        )
                        .await
                    }
                };
            }

            // Lifecycle projections do not contain output. Each transition is
            // persisted before its terminal result is exposed to the service.
            let actions = match self.dispatcher.observe_active(active, runtime, receipts) {
                Ok(actions) => actions,
                Err(error) => {
                    // A provider may still be live after a receipt failure.
                    // Contain that exact handle before surfacing a durable
                    // OutcomeUnknown to the foreground service; we make no
                    // claim that abort cleanup itself was receipted.
                    let _ = self.dispatcher.abort_after_receipt(active).await;
                    let _ = self
                        .dispatcher
                        .cleanup_grok_after_receipt(grok_cleanup_task_tab)
                        .await;
                    return Err(error);
                }
            };
            for action in actions {
                match active_action(action)? {
                    ActiveAction::Continue => continue,
                    ActiveAction::Terminal(result) => {
                        return self
                            .cleanup_after_terminal_receipt(result, grok_cleanup_task_tab)
                            .await;
                    }
                }
            }
            self.clock.wait_for_poll().await;
        }
    }

    async fn await_with_lease<T>(
        &self,
        future: TaskRuntimeFuture<'_, T>,
        lease: &mut TaskRuntimeLeaseKeepalive<'_>,
    ) -> Result<T, TaskRuntimeCoordinatorError> {
        // Check on both sides of an arbitrary app-owned await. The polling
        // branch handles a slow pending future; these two checks also cover a
        // future that becomes ready right at a lease cadence boundary.
        lease
            .heartbeat_if_due(self.clock.now_ms()?)
            .map_err(TaskRuntimeCoordinatorError::LeaseHeartbeat)?;
        tokio::pin!(future);
        let result = loop {
            tokio::select! {
                result = &mut future => break result,
                _ = self.clock.wait_for_poll() => {
                    let now_ms = self.clock.now_ms()?;
                    lease.heartbeat_if_due(now_ms)
                        .map_err(TaskRuntimeCoordinatorError::LeaseHeartbeat)?;
                }
            }
        };
        lease
            .heartbeat_if_due(self.clock.now_ms()?)
            .map_err(TaskRuntimeCoordinatorError::LeaseHeartbeat)?;
        Ok(result)
    }

    async fn cleanup_after_terminal_receipt(
        &self,
        terminal: TaskForegroundRunnerResult,
        grok_cleanup_task_tab: Option<String>,
    ) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
        match self
            .dispatcher
            .cleanup_grok_after_receipt(grok_cleanup_task_tab)
            .await
        {
            Ok(()) => Ok(terminal),
            // The terminal runtime receipt is already durable. Do not report
            // its successful provider outcome as clean completion when the
            // deterministic Grok slot/observer cleanup failed. A known
            // provider failure stays known attention; genuine uncertainty
            // stays uncertainty.
            Err(_) => match terminal {
                TaskForegroundRunnerResult::Completed => {
                    Ok(TaskForegroundRunnerResult::CompletedWithAttention)
                }
                TaskForegroundRunnerResult::CompletedWithAttention => {
                    Ok(TaskForegroundRunnerResult::CompletedWithAttention)
                }
                TaskForegroundRunnerResult::OutcomeUnknown { .. } => Ok(terminal),
            },
        }
    }
}

enum ActiveAction {
    Continue,
    Terminal(TaskForegroundRunnerResult),
}

fn active_action(
    action: PersistedTaskExecutionAction,
) -> Result<ActiveAction, TaskRuntimeCoordinatorError> {
    match action {
        // Activity is a durable committed-start refinement, not a terminal
        // outcome. Continue waiting for a structured provider completion.
        PersistedTaskExecutionAction::CommittedStartRecorded => Ok(ActiveAction::Continue),
        PersistedTaskExecutionAction::Notify(_) => {
            terminal_action(action).map(ActiveAction::Terminal)
        }
        PersistedTaskExecutionAction::RunPreflight(_)
        | PersistedTaskExecutionAction::DispatchProvider(_) => {
            Err(TaskRuntimeCoordinatorError::Runtime(
                TaskExecutionRuntimeError::UnexpectedNoopLifecycleEvent,
            ))
        }
    }
}

impl TaskForegroundExecutionRunner for TaskRuntimeCoordinator {
    fn execute_claimed<'runner>(
        &'runner self,
        claim: TaskForegroundClaim,
    ) -> TaskForegroundRunnerFuture<'runner> {
        Box::pin(self.execute(claim))
    }
}

fn terminal_action(
    action: PersistedTaskExecutionAction,
) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
    match action {
        PersistedTaskExecutionAction::Notify(notification) => match notification.kind {
            crate::task_execution_runtime::TaskExecutionNotificationKind::Completed => {
                Ok(TaskForegroundRunnerResult::Completed)
            }
            crate::task_execution_runtime::TaskExecutionNotificationKind::NeedsAttention => {
                Ok(TaskForegroundRunnerResult::CompletedWithAttention)
            }
            crate::task_execution_runtime::TaskExecutionNotificationKind::OutcomeUnknown
            | crate::task_execution_runtime::TaskExecutionNotificationKind::None => {
                outcome_unknown("task-runtime-needs-attention")
            }
        },
        PersistedTaskExecutionAction::CommittedStartRecorded
        | PersistedTaskExecutionAction::DispatchProvider(_)
        | PersistedTaskExecutionAction::RunPreflight(_) => {
            outcome_unknown("task-runtime-invalid-terminal-action")
        }
    }
}

fn outcome_unknown(code: &str) -> Result<TaskForegroundRunnerResult, TaskRuntimeCoordinatorError> {
    Ok(TaskForegroundRunnerResult::OutcomeUnknown {
        code: TaskForegroundRunnerError::new(code)
            .map_err(|_| TaskRuntimeCoordinatorError::InvalidRunnerCode)?,
    })
}

#[derive(Debug)]
pub(crate) enum TaskRuntimeCoordinatorError {
    TrustUnavailable,
    ClockUnavailable,
    InvalidPollInterval,
    InvalidTimeout,
    InvalidLeaseDuration,
    CancellationCapacity,
    InvalidRunnerCode,
    StoreBinding(TaskExecutionStoreAdapterError),
    LeaseHeartbeat(TaskStoreError),
    DispatchBinding(TaskProviderDispatchBindingError),
    RuntimePlan(crate::task_execution_runtime::TaskExecutionPlanError),
    Runtime(TaskExecutionRuntimeError),
}

impl TaskRuntimeCoordinatorError {
    fn runner_error(&self) -> TaskForegroundRunnerError {
        let code = match self {
            Self::TrustUnavailable => "task-runtime-trust-unavailable",
            Self::ClockUnavailable => "task-runtime-clock-unavailable",
            Self::InvalidPollInterval => "task-runtime-invalid-poll-interval",
            Self::InvalidTimeout => "task-runtime-invalid-timeout",
            Self::InvalidLeaseDuration => "task-runtime-invalid-lease-duration",
            Self::CancellationCapacity => "task-runtime-cancellation-capacity",
            Self::InvalidRunnerCode => "task-runtime-invalid-runner-code",
            Self::StoreBinding(error) => {
                let _ = error;
                "task-runtime-store-binding-failed"
            }
            Self::LeaseHeartbeat(error) => {
                let _ = error;
                "task-runtime-lease-heartbeat-failed"
            }
            Self::DispatchBinding(error) => {
                let _ = error;
                "task-runtime-dispatch-binding-failed"
            }
            Self::RuntimePlan(error) => {
                let _ = error;
                "task-runtime-plan-failed"
            }
            Self::Runtime(error) => {
                let _ = error;
                "task-runtime-transition-failed"
            }
        };
        TaskForegroundRunnerError::new(code).expect("static task runtime error code is valid")
    }
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "task_runtime_coordinator_tests.rs"]
mod tests;
