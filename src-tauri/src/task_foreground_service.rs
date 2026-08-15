//! Foreground-only lifecycle contract for durable ShellX Tasks.
//!
//! This service owns *when* durable task work may be handed to the existing
//! execution runtime, but it owns neither provider command construction nor
//! provider process lifetime. Tauri supplies the app-lifetime timer and an
//! injected runner. Consequently it cannot run while ShellX is closed, and a
//! restart reconciles any abandoned lease to `outcomeUnknown` before planning
//! more work.
//!
//! The hand-off boundary is deliberately narrow:
//!
//! 1. the due planner atomically persists a pending occurrence;
//! 2. this service atomically claims it and writes the claim receipt;
//! 3. only then does it hand an opaque, non-cloneable claim to the injected
//!    execution runner.
//!
//! The runner must use `TaskExecutionStoreBinding` and
//! `TaskExecutionRuntime` before requesting a provider action, then return
//! only after it has a terminal result. A runner error is not interpreted as
//! proof that no work started, so the service terminalizes it as
//! `outcomeUnknown` and never retries it.

use crate::task_due_runner::{TaskDueReadyOccurrence, TaskDueRunRequest, MAX_GLOBAL_ACTIVE_RUNS};
use crate::task_model::{TaskDefinitionRevision, TaskOccurrence, TaskOccurrenceState};
use crate::task_store::{validate_lease_owner, TaskStore, TaskStoreError};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[cfg(test)]
#[path = "task_foreground_service_tests.rs"]
mod tests;

#[path = "task_runtime_coordinator.rs"]
mod task_runtime_coordinator;

#[allow(unused_imports)]
pub(crate) use task_runtime_coordinator::{
    TaskRuntimeCancellation, TaskRuntimeCoordinator, TaskRuntimeCoordinatorConfig,
    TaskRuntimeCoordinatorError, TaskRuntimeGrokCleanupError, TaskRuntimeGrokPreparation,
    TaskRuntimeGrokSessionStarter, TaskRuntimeProgressObserver, TaskRuntimeProviderDispatcher,
    TaskRuntimeTrustResolver, TaskRuntimeTrustedInputs,
};

/// The foreground coordinator makes no assumptions about a host event loop.
/// Tauri calls `poll_once` from its app-owned timer, while tests use
/// `poll_tick` with an exact value.
pub(crate) trait TaskForegroundClock: Send + Sync {
    fn next_tick(&self) -> Result<TaskForegroundTick, TaskForegroundClockError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundTick {
    now_ms: i64,
}

impl TaskForegroundTick {
    pub(crate) fn new(now_ms: i64) -> Result<Self, TaskForegroundTickError> {
        if now_ms <= 0 {
            return Err(TaskForegroundTickError::NonPositiveNowMs);
        }
        Ok(Self { now_ms })
    }

    pub(crate) fn now_ms(self) -> i64 {
        self.now_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundTickError {
    NonPositiveNowMs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundClockError {
    Unavailable,
}

/// Production wall clock. Tests should inject a deterministic clock or call
/// `poll_tick` directly; no task decision reads time implicitly from storage.
#[derive(Default)]
pub(crate) struct SystemTaskForegroundClock;

impl TaskForegroundClock for SystemTaskForegroundClock {
    fn next_tick(&self) -> Result<TaskForegroundTick, TaskForegroundClockError> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| TaskForegroundClockError::Unavailable)?;
        let now_ms = i64::try_from(elapsed.as_millis())
            .map_err(|_| TaskForegroundClockError::Unavailable)?;
        TaskForegroundTick::new(now_ms).map_err(|_| TaskForegroundClockError::Unavailable)
    }
}

pub(crate) const DEFAULT_FOREGROUND_LEASE_MS: i64 = 60_000;
const MIN_FOREGROUND_LEASE_MS: i64 = 1_000;
const MAX_FOREGROUND_LEASE_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_RUNNER_FAILURE_CODE_BYTES: usize = 96;

/// Stable app-lifetime configuration. `owner_id` is minted once by Tauri
/// setup, not once per tick, so all receipt ownership is attributable to the
/// one foreground service instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundServiceConfig {
    pub owner_id: String,
    pub lease_duration_ms: i64,
    pub global_active_limit: u8,
}

impl TaskForegroundServiceConfig {
    pub(crate) fn new(
        owner_id: impl AsRef<str>,
        lease_duration_ms: i64,
        global_active_limit: u8,
    ) -> Result<Self, TaskForegroundConfigError> {
        let owner_id = validate_lease_owner(owner_id.as_ref())
            .map_err(|_| TaskForegroundConfigError::InvalidOwnerId)?;
        if !(MIN_FOREGROUND_LEASE_MS..=MAX_FOREGROUND_LEASE_MS).contains(&lease_duration_ms) {
            return Err(TaskForegroundConfigError::InvalidLeaseDuration);
        }
        if !(1..=MAX_GLOBAL_ACTIVE_RUNS).contains(&global_active_limit) {
            return Err(TaskForegroundConfigError::InvalidGlobalActiveLimit);
        }
        Ok(Self {
            owner_id,
            lease_duration_ms,
            global_active_limit,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(clippy::enum_variant_names)]
pub(crate) enum TaskForegroundConfigError {
    InvalidOwnerId,
    InvalidLeaseDuration,
    InvalidGlobalActiveLimit,
}

/// An opaque, one-shot hand-off after durable claim persistence. It is not
/// cloneable, so a normal execution adapter cannot accidentally replay the
/// same occurrence on a second provider.
pub(crate) struct TaskForegroundClaim {
    store: Arc<TaskStore>,
    occurrence: TaskOccurrence,
    revision: TaskDefinitionRevision,
    owner_id: String,
    lease_id: String,
}

impl TaskForegroundClaim {
    pub(crate) fn store(&self) -> &TaskStore {
        self.store.as_ref()
    }

    pub(crate) fn occurrence(&self) -> &TaskOccurrence {
        &self.occurrence
    }

    pub(crate) fn revision(&self) -> &TaskDefinitionRevision {
        &self.revision
    }

    pub(crate) fn owner_id(&self) -> &str {
        &self.owner_id
    }

    pub(crate) fn lease_id(&self) -> &str {
        &self.lease_id
    }

    /// Original persisted lease duration. The execution coordinator derives a
    /// heartbeat cadence from this exact claimed lease instead of inventing a
    /// second timeout or extending an unowned occurrence.
    pub(crate) fn lease_duration_ms(&self) -> i64 {
        self.occurrence
            .active_lease
            .as_ref()
            .map(|lease| lease.expires_at_ms.saturating_sub(lease.claimed_at_ms))
            .unwrap_or_default()
    }
}

/// The injected runner executes through the existing normalized provider
/// runtime. It must not return after merely spawning or attaching to a
/// provider session: a return means it has a terminal result. `Completed` is
/// finalized by this service through the owner-bound store transition.
///
pub(crate) type TaskForegroundRunnerFuture<'runner> = Pin<
    Box<
        dyn Future<Output = Result<TaskForegroundRunnerResult, TaskForegroundRunnerError>>
            + Send
            + 'runner,
    >,
>;

/// Asynchronous task execution contract owned by ShellX's existing app
/// runtime. Implementations await existing provider runtimes directly; they
/// never use `Handle::block_on`, create a nested Tokio runtime, or detach a
/// second execution worker.
pub(crate) trait TaskForegroundExecutionRunner: Send + Sync {
    fn execute_claimed<'runner>(
        &'runner self,
        claim: TaskForegroundClaim,
    ) -> TaskForegroundRunnerFuture<'runner>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundRunnerResult {
    Completed,
    /// The provider outcome is known and its Task receipt is durable, but it
    /// requires user attention (for example failed, cancelled, timed out, or
    /// preflight inconclusive). The occurrence is still finalized through the
    /// known completion path; this is not an ambiguous external effect.
    CompletedWithAttention,
    OutcomeUnknown {
        code: TaskForegroundRunnerError,
    },
}

/// A bounded, non-sensitive runner error code. Provider output, paths,
/// credentials, and arbitrary error strings are not admitted here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundRunnerError {
    code: String,
}

impl TaskForegroundRunnerError {
    pub(crate) fn new(
        code: impl AsRef<str>,
    ) -> Result<Self, TaskForegroundRunnerErrorValidationError> {
        let code = code.as_ref().trim();
        if code.is_empty()
            || code.len() > MAX_RUNNER_FAILURE_CODE_BYTES
            || code.chars().any(char::is_control)
            || !code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(TaskForegroundRunnerErrorValidationError::InvalidCode);
        }
        Ok(Self {
            code: code.to_string(),
        })
    }

    pub(crate) fn code(&self) -> &str {
        &self.code
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundRunnerErrorValidationError {
    InvalidCode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundLifecycle {
    New,
    Running,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundPollDisposition {
    Ran,
    SkippedSingleFlight,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundClaimRefusal {
    NotFound,
    AlreadyClaimed,
    NotClaimable,
    OutcomeUnknown,
    StoreUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TaskForegroundHandoffOutcome {
    Completed,
    CompletedWithAttention,
    OutcomeUnknown { code: String },
    StoppedBeforeClaim,
    ClaimRefused(TaskForegroundClaimRefusal),
    BindingRefused(TaskForegroundClaimRefusal),
    OutcomeUnknownPersistenceFailed(TaskForegroundClaimRefusal),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundHandoff {
    pub occurrence_id: String,
    pub outcome: TaskForegroundHandoffOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundPollReport {
    pub tick: TaskForegroundTick,
    pub disposition: TaskForegroundPollDisposition,
    pub reconciled_expired_leases: usize,
    pub planned_ready_occurrences: usize,
    pub planned_decisions: usize,
    pub handoffs: Vec<TaskForegroundHandoff>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskForegroundManualRunReport {
    pub tick: TaskForegroundTick,
    pub disposition: TaskForegroundPollDisposition,
    pub reconciled_expired_leases: usize,
    pub handoff: Option<TaskForegroundHandoff>,
}

#[derive(Debug)]
pub(crate) enum TaskForegroundServiceError {
    AlreadyStarted,
    NotStarted,
    Shutdown,
    Clock(TaskForegroundClockError),
    Store(TaskStoreError),
    LifecyclePoisoned,
}

impl From<TaskStoreError> for TaskForegroundServiceError {
    fn from(value: TaskStoreError) -> Self {
        Self::Store(value)
    }
}

impl std::fmt::Display for TaskForegroundServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::AlreadyStarted => "Task foreground service is already started.",
            Self::NotStarted => "Task foreground service is not started.",
            Self::Shutdown => "Task foreground service is shut down.",
            Self::Clock(error) => {
                let _ = error;
                "Task foreground clock is unavailable."
            }
            Self::Store(error) => {
                let _ = error;
                "Task foreground storage operation failed."
            }
            Self::LifecyclePoisoned => "Task foreground lifecycle state is unavailable.",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TaskForegroundServiceError {}

struct TaskForegroundState {
    lifecycle: TaskForegroundLifecycle,
    poll_in_flight: bool,
    active_handoffs: usize,
}

/// App-owned foreground coordinator. It creates no thread, process, provider,
/// login flow, or credential state. Root Tauri integration owns the timer and
/// must call `shutdown` before its app teardown begins.
pub(crate) struct TaskForegroundService {
    store: Arc<TaskStore>,
    clock: Arc<dyn TaskForegroundClock>,
    runner: Arc<dyn TaskForegroundExecutionRunner>,
    config: TaskForegroundServiceConfig,
    state: Mutex<TaskForegroundState>,
    /// Serializes shutdown against the last durable claim and runner execution.
    /// A runner must return only after its terminal result is known and is
    /// persisted or explicitly verified as unknown.
    dispatch_gate: AsyncMutex<()>,
    handoff_finished: Notify,
}

impl TaskForegroundService {
    pub(crate) fn new(
        store: Arc<TaskStore>,
        clock: Arc<dyn TaskForegroundClock>,
        runner: Arc<dyn TaskForegroundExecutionRunner>,
        config: TaskForegroundServiceConfig,
    ) -> Self {
        Self {
            store,
            clock,
            runner,
            config,
            state: Mutex::new(TaskForegroundState {
                lifecycle: TaskForegroundLifecycle::New,
                poll_in_flight: false,
                active_handoffs: 0,
            }),
            dispatch_gate: AsyncMutex::new(()),
            handoff_finished: Notify::new(),
        }
    }

    /// Tauri setup calls this once after the app is live. It immediately polls,
    /// which performs startup expiry reconciliation before it exposes any due
    /// work. A timer may call `poll_once` only while this service remains live.
    pub(crate) async fn start(
        &self,
    ) -> Result<TaskForegroundPollReport, TaskForegroundServiceError> {
        let tick = self
            .clock
            .next_tick()
            .map_err(TaskForegroundServiceError::Clock)?;
        self.start_at(tick).await
    }

    /// Deterministic startup entry point. Tests and a future Tauri lifecycle
    /// hook can provide the exact tick sampled at setup before polling begins.
    pub(crate) async fn start_at(
        &self,
        tick: TaskForegroundTick,
    ) -> Result<TaskForegroundPollReport, TaskForegroundServiceError> {
        {
            let mut state =
                lock(&self.state).map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?;
            match state.lifecycle {
                TaskForegroundLifecycle::New => state.lifecycle = TaskForegroundLifecycle::Running,
                TaskForegroundLifecycle::Running => {
                    return Err(TaskForegroundServiceError::AlreadyStarted)
                }
                TaskForegroundLifecycle::Shutdown => {
                    return Err(TaskForegroundServiceError::Shutdown)
                }
            }
        }
        self.poll_tick(tick).await
    }

    pub(crate) fn lifecycle(&self) -> Result<TaskForegroundLifecycle, TaskForegroundServiceError> {
        Ok(lock(&self.state)
            .map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?
            .lifecycle)
    }

    /// App-owned async timer entry point. Tauri should await this on its
    /// existing application runtime, never through a nested executor or the
    /// UI thread. This service itself creates no detached worker.
    pub(crate) async fn poll_once(
        &self,
    ) -> Result<TaskForegroundPollReport, TaskForegroundServiceError> {
        let lifecycle = self.lifecycle()?;
        if lifecycle == TaskForegroundLifecycle::Shutdown {
            return Err(TaskForegroundServiceError::Shutdown);
        }
        if lifecycle == TaskForegroundLifecycle::New {
            return Err(TaskForegroundServiceError::NotStarted);
        }
        let tick = self
            .clock
            .next_tick()
            .map_err(TaskForegroundServiceError::Clock)?;
        self.poll_tick(tick).await
    }

    /// Deterministic scheduler entry point used by focused tests and Tauri
    /// timer adapters that already own a monotonic wall-clock sample.
    pub(crate) async fn poll_tick(
        &self,
        tick: TaskForegroundTick,
    ) -> Result<TaskForegroundPollReport, TaskForegroundServiceError> {
        let Some(_poll) = self.enter_poll()? else {
            return Ok(TaskForegroundPollReport {
                tick,
                disposition: self.stopped_or_busy_disposition()?,
                reconciled_expired_leases: 0,
                planned_ready_occurrences: 0,
                planned_decisions: 0,
                handoffs: Vec::new(),
            });
        };

        let reconciled_expired_leases = self.store.reconcile_expired_occurrences(tick.now_ms())?;
        let due = self.store.plan_due(TaskDueRunRequest {
            now_ms: tick.now_ms(),
            global_active_limit: self.config.global_active_limit,
        })?;
        let planned_ready_occurrences = due.ready.len();
        let planned_decisions = due.decisions.len();
        // Each ready item already holds a distinct, durable scheduler slot.
        // Join preserves due-planner order in the report while allowing the
        // configured global active limit to represent real app-owned
        // concurrency rather than a hidden runner serialization.
        let handoffs = futures_util::future::join_all(
            due.ready
                .into_iter()
                .map(|ready| self.claim_and_handoff(ready, tick)),
        )
        .await;

        Ok(TaskForegroundPollReport {
            tick,
            disposition: TaskForegroundPollDisposition::Ran,
            reconciled_expired_leases,
            planned_ready_occurrences,
            planned_decisions,
            handoffs,
        })
    }

    /// Exact Run now bridge for root wiring. Root must first create or select
    /// one durable pending occurrence for the immutable revision, then hand
    /// only its occurrence ID here. This routine never accepts an instruction,
    /// provider, target, model, or mutable renderer payload.
    pub(crate) async fn handoff_pending_occurrence(
        &self,
        occurrence_id: impl AsRef<str>,
    ) -> Result<TaskForegroundManualRunReport, TaskForegroundServiceError> {
        if self.lifecycle()? == TaskForegroundLifecycle::Shutdown {
            return Err(TaskForegroundServiceError::Shutdown);
        }
        let tick = self
            .clock
            .next_tick()
            .map_err(TaskForegroundServiceError::Clock)?;
        self.handoff_pending_occurrence_at(occurrence_id, tick)
            .await
    }

    pub(crate) async fn handoff_pending_occurrence_at(
        &self,
        occurrence_id: impl AsRef<str>,
        tick: TaskForegroundTick,
    ) -> Result<TaskForegroundManualRunReport, TaskForegroundServiceError> {
        let Some(_poll) = self.enter_poll()? else {
            return Ok(TaskForegroundManualRunReport {
                tick,
                disposition: self.stopped_or_busy_disposition()?,
                reconciled_expired_leases: 0,
                handoff: None,
            });
        };
        let reconciled_expired_leases = self.store.reconcile_expired_occurrences(tick.now_ms())?;
        let ready = TaskDueReadyOccurrence {
            task_id: String::new(),
            revision_id: String::new(),
            occurrence_id: occurrence_id.as_ref().to_string(),
            scheduled_at_ms: 0,
        };
        let handoff = self.claim_and_handoff(ready, tick).await;
        Ok(TaskForegroundManualRunReport {
            tick,
            disposition: TaskForegroundPollDisposition::Ran,
            reconciled_expired_leases,
            handoff: Some(handoff),
        })
    }

    /// Root Tauri teardown calls this before disposing its timer and runtime.
    /// The dispatch gate means a shutdown either wins before a claim, or waits
    /// until the already-claimed occurrence has been handed to the runner.
    /// It never starts another occurrence after returning.
    pub(crate) async fn shutdown(&self) -> Result<(), TaskForegroundServiceError> {
        let _gate = self.dispatch_gate.lock().await;
        {
            let mut state =
                lock(&self.state).map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?;
            state.lifecycle = TaskForegroundLifecycle::Shutdown;
        }
        drop(_gate);
        loop {
            let active_handoffs = lock(&self.state)
                .map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?
                .active_handoffs;
            if active_handoffs == 0 {
                return Ok(());
            }
            self.handoff_finished.notified().await;
        }
    }

    fn enter_poll(&self) -> Result<Option<PollGuard<'_>>, TaskForegroundServiceError> {
        let mut state =
            lock(&self.state).map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?;
        match state.lifecycle {
            TaskForegroundLifecycle::New => return Err(TaskForegroundServiceError::NotStarted),
            TaskForegroundLifecycle::Shutdown => return Ok(None),
            TaskForegroundLifecycle::Running if state.poll_in_flight => return Ok(None),
            TaskForegroundLifecycle::Running => {}
        }
        state.poll_in_flight = true;
        Ok(Some(PollGuard { state: &self.state }))
    }

    fn stopped_or_busy_disposition(
        &self,
    ) -> Result<TaskForegroundPollDisposition, TaskForegroundServiceError> {
        let state = lock(&self.state).map_err(|_| TaskForegroundServiceError::LifecyclePoisoned)?;
        if state.lifecycle == TaskForegroundLifecycle::Shutdown {
            Ok(TaskForegroundPollDisposition::Stopped)
        } else {
            Ok(TaskForegroundPollDisposition::SkippedSingleFlight)
        }
    }

    async fn claim_and_handoff(
        &self,
        ready: TaskDueReadyOccurrence,
        tick: TaskForegroundTick,
    ) -> TaskForegroundHandoff {
        let occurrence_id = ready.occurrence_id;
        let gate = self.dispatch_gate.lock().await;
        if !self.is_running() {
            return TaskForegroundHandoff {
                occurrence_id,
                outcome: TaskForegroundHandoffOutcome::StoppedBeforeClaim,
            };
        }
        let occurrence = match self.store.claim_occurrence_with_limits(
            &occurrence_id,
            &self.config.owner_id,
            self.config.lease_duration_ms,
            self.config.global_active_limit,
            tick.now_ms(),
        ) {
            Ok(occurrence) => occurrence,
            Err(error) => {
                return TaskForegroundHandoff {
                    occurrence_id,
                    outcome: TaskForegroundHandoffOutcome::ClaimRefused(map_store_refusal(error)),
                }
            }
        };
        let Some(lease) = occurrence.active_lease.as_ref() else {
            return TaskForegroundHandoff {
                occurrence_id,
                outcome: TaskForegroundHandoffOutcome::BindingRefused(
                    TaskForegroundClaimRefusal::NotClaimable,
                ),
            };
        };
        let lease_id = lease.lease_id.clone();
        if occurrence.state != TaskOccurrenceState::Running
            || lease.owner_id != self.config.owner_id
            || lease.expires_at_ms <= tick.now_ms()
        {
            let outcome = self.finalize_outcome_unknown(
                &occurrence_id,
                &lease_id,
                "claimedBindingInconsistent",
                tick,
            );
            return TaskForegroundHandoff {
                occurrence_id,
                outcome,
            };
        }
        let (_, revision) = match self.store.get_execution_binding(&occurrence_id) {
            Ok(binding) => binding,
            Err(_) => {
                let outcome = self.finalize_outcome_unknown(
                    &occurrence_id,
                    &lease_id,
                    "executionBindingUnavailable",
                    tick,
                );
                return TaskForegroundHandoff {
                    occurrence_id,
                    outcome,
                };
            }
        };
        let claim = TaskForegroundClaim {
            store: self.store.clone(),
            occurrence,
            revision,
            owner_id: self.config.owner_id.clone(),
            lease_id: lease_id.clone(),
        };
        {
            let mut state = match lock(&self.state) {
                Ok(state) => state,
                Err(_) => {
                    let outcome = self.finalize_outcome_unknown(
                        &occurrence_id,
                        &lease_id,
                        "foregroundStateUnavailable",
                        tick,
                    );
                    return TaskForegroundHandoff {
                        occurrence_id,
                        outcome,
                    };
                }
            };
            if state.lifecycle != TaskForegroundLifecycle::Running {
                let outcome = self.finalize_outcome_unknown(
                    &occurrence_id,
                    &lease_id,
                    "stoppedAfterClaim",
                    tick,
                );
                return TaskForegroundHandoff {
                    occurrence_id,
                    outcome,
                };
            }
            state.active_handoffs += 1;
        }
        // Keep this guard alive through clock sampling and the owner-bound
        // terminal store write. Shutdown must not report drained merely
        // because a provider future returned while durable finalization is
        // still pending.
        let _active_handoff = ActiveHandoffGuard { service: self };
        drop(gate);
        let runner_result = self.runner.execute_claimed(claim).await;
        // Completion time is sampled only after the provider future resolves,
        // not reused from the pre-dispatch scheduler tick. Without that sample
        // a successful-looking return cannot safely become a completed task.
        let terminal_tick = match self.clock.next_tick() {
            Ok(tick) => tick,
            Err(_) => {
                // Keep uncertainty terminalization at a post-run wall-clock
                // sample where possible. The injected clock failure is itself
                // unsafe, so this deliberately records OutcomeUnknown rather
                // than backdating a claimed completion.
                let fallback_tick = SystemTaskForegroundClock.next_tick().unwrap_or(tick);
                let outcome = self.finalize_outcome_unknown(
                    &occurrence_id,
                    &lease_id,
                    "terminalClockUnavailable",
                    fallback_tick,
                );
                return TaskForegroundHandoff {
                    occurrence_id,
                    outcome,
                };
            }
        };
        match runner_result {
            Ok(
                result @ (TaskForegroundRunnerResult::Completed
                | TaskForegroundRunnerResult::CompletedWithAttention),
            ) => {
                let completed_with_attention =
                    matches!(result, TaskForegroundRunnerResult::CompletedWithAttention);
                match self.store.complete_occurrence(
                    &occurrence_id,
                    &lease_id,
                    &self.config.owner_id,
                    terminal_tick.now_ms(),
                ) {
                    Ok(terminal)
                        if terminal.state == TaskOccurrenceState::Completed
                            && terminal.active_lease.is_none() =>
                    {
                        TaskForegroundHandoff {
                            occurrence_id,
                            outcome: if completed_with_attention {
                                TaskForegroundHandoffOutcome::CompletedWithAttention
                            } else {
                                TaskForegroundHandoffOutcome::Completed
                            },
                        }
                    }
                    Ok(_) | Err(TaskStoreError::OutcomeUnknown) => TaskForegroundHandoff {
                        occurrence_id,
                        outcome: TaskForegroundHandoffOutcome::OutcomeUnknown {
                            code: "leaseExpiredBeforeCompletion".to_string(),
                        },
                    },
                    Err(_) => {
                        let outcome = self.finalize_outcome_unknown(
                            &occurrence_id,
                            &lease_id,
                            "completionPersistenceFailed",
                            terminal_tick,
                        );
                        TaskForegroundHandoff {
                            occurrence_id,
                            outcome,
                        }
                    }
                }
            }
            Ok(TaskForegroundRunnerResult::OutcomeUnknown { code }) => {
                let outcome = self.finalize_outcome_unknown(
                    &occurrence_id,
                    &lease_id,
                    code.code(),
                    terminal_tick,
                );
                TaskForegroundHandoff {
                    occurrence_id,
                    outcome,
                }
            }
            Err(error) => {
                let outcome = self.finalize_outcome_unknown(
                    &occurrence_id,
                    &lease_id,
                    error.code(),
                    terminal_tick,
                );
                TaskForegroundHandoff {
                    occurrence_id,
                    outcome,
                }
            }
        }
    }

    fn finalize_outcome_unknown(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        reason_code: &str,
        tick: TaskForegroundTick,
    ) -> TaskForegroundHandoffOutcome {
        match self.store.mark_occurrence_outcome_unknown(
            occurrence_id,
            lease_id,
            &self.config.owner_id,
            reason_code,
            tick.now_ms(),
        ) {
            Ok(terminal)
                if terminal.state == TaskOccurrenceState::OutcomeUnknown
                    && terminal.active_lease.is_none() =>
            {
                TaskForegroundHandoffOutcome::OutcomeUnknown {
                    code: reason_code.to_string(),
                }
            }
            Ok(_) => TaskForegroundHandoffOutcome::OutcomeUnknownPersistenceFailed(
                TaskForegroundClaimRefusal::NotClaimable,
            ),
            Err(error) => TaskForegroundHandoffOutcome::OutcomeUnknownPersistenceFailed(
                map_store_refusal(error),
            ),
        }
    }

    fn is_running(&self) -> bool {
        lock(&self.state)
            .map(|state| state.lifecycle == TaskForegroundLifecycle::Running)
            .unwrap_or(false)
    }

    fn finish_handoff(&self) {
        if let Ok(mut state) = lock(&self.state) {
            state.active_handoffs = state.active_handoffs.saturating_sub(1);
        }
        self.handoff_finished.notify_waiters();
    }
}

struct ActiveHandoffGuard<'a> {
    service: &'a TaskForegroundService,
}

impl Drop for ActiveHandoffGuard<'_> {
    fn drop(&mut self) {
        self.service.finish_handoff();
    }
}

struct PollGuard<'a> {
    state: &'a Mutex<TaskForegroundState>,
}

impl Drop for PollGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = lock(self.state) {
            state.poll_in_flight = false;
        }
    }
}

fn map_store_refusal(error: TaskStoreError) -> TaskForegroundClaimRefusal {
    match error {
        TaskStoreError::NotFound => TaskForegroundClaimRefusal::NotFound,
        TaskStoreError::OccurrenceClaimed => TaskForegroundClaimRefusal::AlreadyClaimed,
        TaskStoreError::OccurrenceNotClaimable => TaskForegroundClaimRefusal::NotClaimable,
        TaskStoreError::OutcomeUnknown => TaskForegroundClaimRefusal::OutcomeUnknown,
        TaskStoreError::CorruptionPreserved
        | TaskStoreError::RecoveryRequired
        | TaskStoreError::Conflict
        | TaskStoreError::LeaseMismatch
        | TaskStoreError::Invalid(_)
        | TaskStoreError::Io(_)
        | TaskStoreError::Serialization(_) => TaskForegroundClaimRefusal::StoreUnavailable,
    }
}

fn lock<T>(
    mutex: &Mutex<T>,
) -> Result<MutexGuard<'_, T>, std::sync::PoisonError<MutexGuard<'_, T>>> {
    mutex.lock()
}
