//! Tauri-owned lifecycle wiring for durable ShellX Tasks.
//!
//! This module joins the pure scheduler/coordinator to the application's one
//! durable TaskStore and existing provider registries. It does not construct a
//! provider command, inspect authentication, create another runtime, or retain
//! provider output.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_notification::NotificationExt as _;

use crate::acp::{GrokAcpLifecycleObserver, SessionRegistry};
use crate::build_orchestrator::BuildOrchestrator;
use crate::goal_orchestrator::GoalOrchestrator;
use crate::process_registry::ProcessRegistry;
use crate::provider_sessions::{ProviderSessionEmit, ProviderSessionRegistry};
use crate::task_execution_bindings::TaskExecutionBindingAuthority;
use crate::task_foreground_service::{
    SystemTaskForegroundClock, TaskForegroundClaim, TaskForegroundService,
    TaskForegroundServiceConfig, TaskRuntimeCancellation, TaskRuntimeCoordinator,
    TaskRuntimeCoordinatorConfig, TaskRuntimeCoordinatorError, TaskRuntimeGrokCleanupError,
    TaskRuntimeGrokPreparation, TaskRuntimeGrokSessionStarter, TaskRuntimeProgressObserver,
    TaskRuntimeProviderDispatcher, TaskRuntimeTrustResolver, TaskRuntimeTrustedInputs,
    DEFAULT_FOREGROUND_LEASE_MS,
};
use crate::task_model::TaskNotificationPolicy;
use crate::task_provider_dispatch::{
    TaskExternalProviderRuntime, TaskGrokAcpEventBuffer, TaskGrokAcpRuntime,
    TaskGrokSessionStartContext,
};
use crate::task_runtime_authority::{
    TaskRuntimeAuthority, TaskRuntimeAuthorityResolver as CanonicalAuthorityResolver,
};
use crate::task_store::{TaskStore, TaskStoreService};

const TASK_RUNTIME_POLL_INTERVAL: Duration = Duration::from_secs(30);
const TASK_RUNTIME_GLOBAL_ACTIVE_LIMIT: u8 = 4;

struct AppTaskRuntimeProgressObserver {
    app: AppHandle,
    store: Arc<TaskStore>,
    conversations: Arc<crate::task_conversation::TaskConversationArchive>,
}

impl TaskRuntimeProgressObserver for AppTaskRuntimeProgressObserver {
    fn attempt_active(&self, occurrence_id: &str, attempt_id: &str) {
        match self.store.get_execution_binding(occurrence_id) {
            Ok((occurrence, revision)) => {
                let identity = crate::task_execution_runtime::TaskExecutionIdentity {
                    task_id: occurrence.task_id,
                    revision_id: occurrence.revision_id,
                    revision_sha256: revision.canonical_sha256.clone(),
                    occurrence_id: occurrence.occurrence_id,
                    attempt_id: attempt_id.to_string(),
                };
                if let Err(error) = self.conversations.begin(
                    &identity,
                    &revision,
                    crate::task_store::current_time_ms(),
                ) {
                    tracing::warn!(
                        occurrence_id,
                        attempt_id,
                        error = %error,
                        "Task conversation archive could not be initialized"
                    );
                }
            }
            Err(error) => tracing::warn!(
                ?error,
                occurrence_id,
                attempt_id,
                "Task conversation binding could not be loaded"
            ),
        }
        let _ = self.app.emit(
            "tasks-updated",
            serde_json::json!({
                "reason": "attemptActive",
                "occurrenceId": occurrence_id,
            }),
        );
    }
}

/// One managed app-lifetime Task runtime. Tauri commands use this same state
/// for Run now/cancel; setup and main-window teardown own start/shutdown.
pub(crate) struct TaskRuntimeAppState {
    service: Arc<TaskForegroundService>,
    cancellation: Arc<TaskRuntimeCancellation>,
    terminal_notifier: Arc<AppTaskTerminalNotifier>,
}

struct AppTaskTerminalNotifier {
    app: AppHandle,
    store: Arc<TaskStore>,
    browser_registry: Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    conversations: Arc<crate::task_conversation::TaskConversationArchive>,
}

impl AppTaskTerminalNotifier {
    fn notify(&self, handoff: &crate::task_foreground_service::TaskForegroundHandoff) {
        self.finish_conversation(handoff);
        self.record_result_evidence(&handoff.occurrence_id);
        let Ok((_, revision)) = self.store.get_execution_binding(&handoff.occurrence_id) else {
            tracing::warn!(
                occurrence_id = %handoff.occurrence_id,
                "Task notification skipped because immutable run binding was unavailable"
            );
            return;
        };
        let Some(body) =
            task_terminal_notification_body(revision.draft.notification_policy, &handoff.outcome)
        else {
            return;
        };
        let notification_attempt = match self.store.record_notification_attempt(
            &handoff.occurrence_id,
            crate::task_store::current_time_ms(),
        ) {
            Ok(attempt) => attempt,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    occurrence_id = %handoff.occurrence_id,
                    "Task notification skipped because its durable attempt receipt was not persisted"
                );
                return;
            }
        };
        if !notification_attempt.should_deliver {
            return;
        }
        if let Err(error) = self
            .app
            .notification()
            .builder()
            .title("ShellX Task")
            .body(body)
            .show()
        {
            tracing::warn!(
                ?error,
                occurrence_id = %handoff.occurrence_id,
                receipt_id = %notification_attempt.receipt.receipt_id,
                "durable Task terminal notification could not be displayed"
            );
        }
    }

    fn finish_conversation(&self, handoff: &crate::task_foreground_service::TaskForegroundHandoff) {
        let terminal_state = match &handoff.outcome {
            crate::task_foreground_service::TaskForegroundHandoffOutcome::Completed => "completed",
            crate::task_foreground_service::TaskForegroundHandoffOutcome::CompletedWithAttention => {
                "completedWithAttention"
            }
            crate::task_foreground_service::TaskForegroundHandoffOutcome::OutcomeUnknown { .. } => {
                "outcomeUnknown"
            }
            crate::task_foreground_service::TaskForegroundHandoffOutcome::StoppedBeforeClaim
            | crate::task_foreground_service::TaskForegroundHandoffOutcome::ClaimRefused(_)
            | crate::task_foreground_service::TaskForegroundHandoffOutcome::BindingRefused(_)
            | crate::task_foreground_service::TaskForegroundHandoffOutcome::OutcomeUnknownPersistenceFailed(_) => {
                return;
            }
        };
        let Ok((occurrence, revision)) = self.store.get_execution_binding(&handoff.occurrence_id)
        else {
            return;
        };
        let Some(attempt) = occurrence.attempts.last() else {
            return;
        };
        let identity = crate::task_execution_runtime::TaskExecutionIdentity {
            task_id: occurrence.task_id,
            revision_id: occurrence.revision_id,
            revision_sha256: revision.canonical_sha256,
            occurrence_id: occurrence.occurrence_id,
            attempt_id: attempt.attempt_id.clone(),
        };
        let tab_id = crate::task_provider_dispatch::task_runtime_tab_id(&identity);
        let flush = match self.conversations.finish(
            &tab_id,
            terminal_state,
            crate::task_store::current_time_ms(),
        ) {
            Ok(Some(summary)) if summary.dropped_events > 0 || summary.write_failed => {
                tracing::warn!(
                    occurrence_id = %handoff.occurrence_id,
                    dropped_events = summary.dropped_events,
                    write_failed = summary.write_failed,
                    "Task conversation archive finished with incomplete Trace evidence"
                );
                Some(summary)
            }
            Ok(summary) => summary,
            Err(error) => {
                tracing::warn!(
                    occurrence_id = %handoff.occurrence_id,
                    error = %error,
                    "Task conversation archive could not be finalized"
                );
                None
            }
        };
        let snapshot = match self.conversations.inspect(&tab_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::warn!(
                    occurrence_id = %handoff.occurrence_id,
                    error = %error,
                    "Task conversation archive could not be inspected"
                );
                None
            }
        };
        self.record_trace_evidence(&handoff.occurrence_id, snapshot, flush, false);
    }

    fn record_trace_evidence(
        &self,
        occurrence_id: &str,
        snapshot: Option<crate::task_conversation::TaskConversationEvidenceSnapshot>,
        flush: Option<crate::task_conversation::TaskConversationFlushSummary>,
        recovered_after_restart: bool,
    ) {
        match crate::task_trace_evidence::collect_task_trace_evidence(
            &self.store,
            occurrence_id,
            snapshot,
            flush,
            recovered_after_restart,
            crate::task_store::current_time_ms(),
        ) {
            Ok(crate::task_trace_evidence::TaskTraceEvidenceOutcome::Recorded(receipt)) => {
                let _ = self.app.emit(
                    "tasks-updated",
                    serde_json::json!({
                        "reason": "traceEvidenceRecorded",
                        "occurrenceId": occurrence_id,
                        "receiptId": receipt.receipt_id,
                    }),
                );
            }
            Ok(crate::task_trace_evidence::TaskTraceEvidenceOutcome::AlreadyRecorded) => {}
            Err(error) => tracing::warn!(
                ?error,
                occurrence_id,
                "Task Trace evidence could not be recorded"
            ),
        }
    }

    fn retry_missing_trace_evidence(&self) {
        match self.store.pending_trace_evidence_occurrences(
            crate::task_trace_evidence::MAX_TRACE_EVIDENCE_RETRY_BATCH,
        ) {
            Ok(occurrence_ids) => {
                for occurrence_id in occurrence_ids {
                    let snapshot =
                        self.task_conversation_session_id(&occurrence_id)
                            .and_then(|session_id| match self.conversations.inspect(&session_id) {
                                Ok(snapshot) => snapshot,
                                Err(error) => {
                                    tracing::warn!(
                                        occurrence_id,
                                        error = %error,
                                        "Task conversation recovery inspection failed"
                                    );
                                    None
                                }
                            });
                    self.record_trace_evidence(&occurrence_id, snapshot, None, true);
                }
            }
            Err(error) => tracing::warn!(?error, "Task Trace-evidence recovery scan could not run"),
        }
    }

    fn task_conversation_session_id(&self, occurrence_id: &str) -> Option<String> {
        let (occurrence, revision) = self.store.get_execution_binding(occurrence_id).ok()?;
        let attempt = occurrence.attempts.last()?;
        Some(crate::task_provider_dispatch::task_runtime_tab_id(
            &crate::task_execution_runtime::TaskExecutionIdentity {
                task_id: occurrence.task_id,
                revision_id: occurrence.revision_id,
                revision_sha256: revision.canonical_sha256,
                occurrence_id: occurrence.occurrence_id,
                attempt_id: attempt.attempt_id.clone(),
            },
        ))
    }

    fn record_result_evidence(&self, occurrence_id: &str) {
        match crate::task_result_evidence::collect_browser_result_evidence(
            &self.store,
            &self.browser_registry,
            occurrence_id,
            crate::task_store::current_time_ms(),
        ) {
            Ok(crate::task_result_evidence::TaskBrowserResultEvidenceOutcome::Recorded(
                receipt,
            )) => {
                let _ = self.app.emit(
                    "tasks-updated",
                    serde_json::json!({
                        "reason": "resultEvidenceRecorded",
                        "occurrenceId": occurrence_id,
                        "receiptId": receipt.receipt_id,
                    }),
                );
            }
            Ok(
                crate::task_result_evidence::TaskBrowserResultEvidenceOutcome::NotApplicable
                | crate::task_result_evidence::TaskBrowserResultEvidenceOutcome::AlreadyRecorded,
            ) => {}
            Err(error) => {
                tracing::warn!(
                    ?error,
                    occurrence_id = %occurrence_id,
                    "Task Browser result evidence could not be recorded"
                );
            }
        }
    }

    fn retry_missing_result_evidence(&self) {
        match self.store.pending_browser_result_evidence_occurrences(
            crate::task_result_evidence::MAX_RESULT_EVIDENCE_RETRY_BATCH,
        ) {
            Ok(occurrence_ids) => {
                for occurrence_id in occurrence_ids {
                    self.record_result_evidence(&occurrence_id);
                }
            }
            Err(error) => tracing::warn!(
                ?error,
                "Task Browser result-evidence recovery scan could not run"
            ),
        }
    }

    fn notify_all(&self, handoffs: &[crate::task_foreground_service::TaskForegroundHandoff]) {
        for handoff in handoffs {
            self.notify(handoff);
        }
    }
}

fn task_terminal_notification_body(
    policy: TaskNotificationPolicy,
    outcome: &crate::task_foreground_service::TaskForegroundHandoffOutcome,
) -> Option<&'static str> {
    use crate::task_foreground_service::TaskForegroundHandoffOutcome;

    match (policy, outcome) {
        (TaskNotificationPolicy::None, _) => None,
        (
            TaskNotificationPolicy::AttentionOnly | TaskNotificationPolicy::EveryTerminalResult,
            TaskForegroundHandoffOutcome::CompletedWithAttention,
        ) => Some(
            "A ShellX Task needs attention. Open Task Manager to review its receipt-backed status.",
        ),
        (
            TaskNotificationPolicy::AttentionOnly | TaskNotificationPolicy::EveryTerminalResult,
            TaskForegroundHandoffOutcome::OutcomeUnknown { .. },
        ) => Some("A ShellX Task outcome is uncertain. Open Task Manager before running it again."),
        (TaskNotificationPolicy::EveryTerminalResult, TaskForegroundHandoffOutcome::Completed) => {
            Some("A ShellX Task finished. Open Task Manager for its receipt-backed result.")
        }
        _ => None,
    }
}

impl TaskRuntimeAppState {
    pub(crate) fn service(&self) -> Arc<TaskForegroundService> {
        self.service.clone()
    }

    pub(crate) fn cancellation(&self) -> Arc<TaskRuntimeCancellation> {
        self.cancellation.clone()
    }

    pub(crate) async fn shutdown(&self) {
        if let Err(error) = self.service.shutdown().await {
            tracing::warn!(
                ?error,
                "task foreground runtime shutdown did not drain cleanly"
            );
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskManualRunQueueReceipt {
    pub occurrence_id: String,
    pub disposition: &'static str,
}

/// Persist one exact-revision manual occurrence before asking the one managed
/// foreground service to advance it. This is the shared UI/Debug API boundary:
/// callers receive durable queue acceptance, never a claim that provider work
/// has started. A busy handoff remains restart-safe because the normal planner
/// re-exposes untouched pending manual occurrences.
pub(crate) fn queue_manual_run(
    task_store: &TaskStoreService,
    task_runtime: &TaskRuntimeAppState,
    app: &AppHandle,
    task_id: &str,
    revision_id: &str,
    revision_hash: &str,
) -> Result<TaskManualRunQueueReceipt, String> {
    let occurrence = task_store.create_manual_occurrence(
        task_id,
        revision_id,
        revision_hash,
        crate::task_store::current_time_ms(),
    )?;
    let occurrence_id = occurrence.occurrence_id.clone();
    let queued_occurrence_id = occurrence_id.clone();
    let service = task_runtime.service();
    let terminal_notifier = task_runtime.terminal_notifier.clone();
    let emitter = app.clone();
    let _ = app.emit(
        "tasks-updated",
        serde_json::json!({
            "reason": "manualRunQueued",
            "occurrenceId": occurrence_id,
        }),
    );
    tauri::async_runtime::spawn(async move {
        let result = service
            .handoff_pending_occurrence(&queued_occurrence_id)
            .await;
        if let Err(error) = &result {
            tracing::warn!(
                ?error,
                occurrence_id = %queued_occurrence_id,
                "manual Task handoff remains queued for foreground reconciliation"
            );
        } else if let Ok(report) = &result {
            if let Some(handoff) = &report.handoff {
                terminal_notifier.notify(handoff);
            }
        }
        let _ = emitter.emit(
            "tasks-updated",
            serde_json::json!({
                "reason": "manualRunAdvanced",
                "occurrenceId": queued_occurrence_id,
            }),
        );
    });
    Ok(TaskManualRunQueueReceipt {
        occurrence_id,
        disposition: "queued",
    })
}

struct AppTaskRuntimeTrustResolver {
    authority: TaskRuntimeAuthority,
    bindings: TaskExecutionBindingAuthority,
}

impl TaskRuntimeTrustResolver for AppTaskRuntimeTrustResolver {
    fn resolve_for_claim<'a>(
        &'a self,
        claim: &'a TaskForegroundClaim,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<TaskRuntimeTrustedInputs, TaskRuntimeCoordinatorError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let now_ms = crate::task_store::current_time_ms();
            let resolved = self
                .authority
                .resolve(claim.revision(), now_ms)
                .await
                .map_err(|_| TaskRuntimeCoordinatorError::TrustUnavailable)?;
            let bindings = self
                .bindings
                .resolve(claim.revision(), &resolved.resolved_target, now_ms)
                .await;
            Ok(TaskRuntimeTrustedInputs::new(
                resolved.catalogue,
                resolved.resolved_target,
                resolved.runtime_policy,
                bindings,
            ))
        })
    }
}

struct AppTaskGrokObserver {
    events: TaskGrokAcpEventBuffer,
}

impl GrokAcpLifecycleObserver for AppTaskGrokObserver {
    fn observe(&self, tab_id: &str, envelope: &serde_json::Value) {
        self.events.observe_payload(tab_id, envelope);
    }
}

struct AppTaskGrokSessionStarter {
    app: AppHandle,
    session_registry: Arc<SessionRegistry>,
    goal_orchestrator: Arc<GoalOrchestrator>,
    build_orchestrator: Arc<BuildOrchestrator>,
    process_registry: Arc<ProcessRegistry>,
    provider_registry: Arc<ProviderSessionRegistry>,
}

impl TaskRuntimeGrokSessionStarter for AppTaskGrokSessionStarter {
    fn prepare_fresh_grok_session<'a>(
        &'a self,
        context: TaskGrokSessionStartContext,
        events: TaskGrokAcpEventBuffer,
    ) -> Pin<Box<dyn Future<Output = TaskRuntimeGrokPreparation> + Send + 'a>> {
        Box::pin(async move {
            let task_tab_id = context.task_tab_id().to_string();
            if let Some(existing) = self.session_registry.get_existing(&task_tab_id).await {
                if existing.lock().await.has_active_child() {
                    return TaskRuntimeGrokPreparation::RejectedBeforePrompt {
                        cleanup_required: false,
                    };
                }
            }

            let session = self.session_registry.get_or_create(&task_tab_id).await;
            let observer: Arc<dyn GrokAcpLifecycleObserver> =
                Arc::new(AppTaskGrokObserver { events });
            session.lock().await.set_lifecycle_observer(Some(observer));

            let connection = if context.connection_id() == "local" {
                crate::TaskGrokConnectionContext::Local
            } else {
                crate::TaskGrokConnectionContext::SavedConnectionId(
                    context.connection_id().to_string(),
                )
            };
            let start = crate::TaskGrokSessionStartContext {
                connection,
                task_tab_id,
                cwd: context.canonical_cwd().to_string(),
                permission_mode: context.permission_mode().clone(),
                shellx_tool_exposure: context.shellx_tool_exposure(),
            };
            match crate::start_fresh_task_grok_session(
                self.app.clone(),
                self.session_registry.clone(),
                start,
            )
            .await
            {
                Ok(()) => TaskRuntimeGrokPreparation::Ready,
                Err(error) => {
                    tracing::warn!(
                        tab_id = %context.task_tab_id(),
                        error = %error,
                        "fresh Task Grok session was rejected before its task prompt"
                    );
                    TaskRuntimeGrokPreparation::RejectedBeforePrompt {
                        cleanup_required: true,
                    }
                }
            }
        })
    }

    fn cleanup_task_tab<'a>(
        &'a self,
        task_tab_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), TaskRuntimeGrokCleanupError>> + Send + 'a>> {
        Box::pin(async move {
            crate::cleanup_normal_tab_session(
                &task_tab_id,
                self.session_registry.clone(),
                self.goal_orchestrator.clone(),
                self.build_orchestrator.clone(),
                self.process_registry.clone(),
                self.provider_registry.clone(),
            )
            .await
            .map(|_| ())
            .map_err(|_| TaskRuntimeGrokCleanupError::Failed)
        })
    }
}

fn normal_provider_emit(app: &AppHandle) -> ProviderSessionEmit {
    let emitter = app.clone();
    #[cfg(feature = "debug-api")]
    let debug_hub = app
        .try_state::<Arc<crate::debug_api::DebugHub>>()
        .map(|state| state.inner().clone());
    Arc::new(move |kind, payload| {
        let tab_id = payload
            .pointer("/_meta/tabId")
            .and_then(serde_json::Value::as_str);
        crate::task_conversation::record_tauri_event(&emitter, kind, &payload, tab_id);
        #[cfg(feature = "debug-api")]
        if let Some(hub) = &debug_hub {
            hub.record_raw_event(kind, payload.clone());
        }
        let _ = emitter.emit(kind, payload);
    })
}

/// Build and start the one foreground Task runtime after Tauri has installed
/// every canonical registry. The caller logs a refusal without aborting ShellX
/// so a corrupt/recovery-required Task store cannot hide the rest of the app.
pub(crate) fn install_task_runtime(
    app: &mut tauri::App,
) -> Result<Arc<TaskRuntimeAppState>, String> {
    let task_store = app.state::<Arc<TaskStoreService>>().execution_store()?;
    let session_registry = app.state::<Arc<SessionRegistry>>().inner().clone();
    let provider_registry = app.state::<Arc<ProviderSessionRegistry>>().inner().clone();
    let process_registry = app.state::<Arc<ProcessRegistry>>().inner().clone();
    let goal_orchestrator = app.state::<Arc<GoalOrchestrator>>().inner().clone();
    let build_orchestrator = app.state::<Arc<BuildOrchestrator>>().inner().clone();
    let browser_registry = app
        .state::<Arc<crate::shellx_browser::ShellxBrowserRegistry>>()
        .inner()
        .clone();
    let vault_backend = app
        .state::<Arc<crate::shellx_vault::ShellxVaultBackend>>()
        .inner()
        .clone();
    let conversations = Arc::new(crate::task_conversation::TaskConversationArchive::new());
    if !app.manage(conversations.clone()) {
        return Err("Task conversation archive was already installed.".to_string());
    }

    let starter: Arc<dyn TaskRuntimeGrokSessionStarter> = Arc::new(AppTaskGrokSessionStarter {
        app: app.handle().clone(),
        session_registry: session_registry.clone(),
        goal_orchestrator,
        build_orchestrator,
        process_registry,
        provider_registry: provider_registry.clone(),
    });
    let dispatcher = TaskRuntimeProviderDispatcher::new(
        TaskExternalProviderRuntime::new(provider_registry, normal_provider_emit(app.handle())),
        TaskGrokAcpRuntime::new(session_registry),
        starter,
    );
    let trust_resolver: Arc<dyn TaskRuntimeTrustResolver> = Arc::new(AppTaskRuntimeTrustResolver {
        authority: TaskRuntimeAuthority::canonical(),
        bindings: TaskExecutionBindingAuthority::canonical(
            browser_registry.clone(),
            vault_backend,
            task_store.clone(),
        ),
    });
    let cancellation = Arc::new(TaskRuntimeCancellation::default());
    let coordinator = Arc::new(
        TaskRuntimeCoordinator::new(
            trust_resolver,
            dispatcher,
            cancellation.clone(),
            TaskRuntimeCoordinatorConfig::default(),
        )
        .map_err(|_| "Task runtime coordinator configuration is invalid.".to_string())?
        .with_progress_observer(Arc::new(AppTaskRuntimeProgressObserver {
            app: app.handle().clone(),
            store: task_store.clone(),
            conversations: conversations.clone(),
        })),
    );
    let config = TaskForegroundServiceConfig::new(
        format!("task-foreground-{}", uuid::Uuid::new_v4()),
        DEFAULT_FOREGROUND_LEASE_MS,
        TASK_RUNTIME_GLOBAL_ACTIVE_LIMIT,
    )
    .map_err(|_| "Task foreground service configuration is invalid.".to_string())?;
    let terminal_notifier = Arc::new(AppTaskTerminalNotifier {
        app: app.handle().clone(),
        store: task_store.clone(),
        browser_registry,
        conversations,
    });
    let service = Arc::new(TaskForegroundService::new(
        task_store,
        Arc::new(SystemTaskForegroundClock),
        coordinator,
        config,
    ));
    let state = Arc::new(TaskRuntimeAppState {
        service: service.clone(),
        cancellation,
        terminal_notifier: terminal_notifier.clone(),
    });
    if !app.manage(state.clone()) {
        return Err("Task runtime app state was already installed.".to_string());
    }

    let emitter = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        match service.start().await {
            Ok(report) => {
                terminal_notifier.notify_all(&report.handoffs);
                terminal_notifier.retry_missing_trace_evidence();
                terminal_notifier.retry_missing_result_evidence();
                let _ = emitter.emit(
                    "tasks-updated",
                    serde_json::json!({ "reason": "foregroundStarted" }),
                );
            }
            Err(error) => {
                tracing::warn!(?error, "task foreground runtime did not start");
                return;
            }
        }
        loop {
            tokio::time::sleep(TASK_RUNTIME_POLL_INTERVAL).await;
            match service.poll_once().await {
                Ok(report) => {
                    terminal_notifier.notify_all(&report.handoffs);
                    terminal_notifier.retry_missing_trace_evidence();
                    terminal_notifier.retry_missing_result_evidence();
                    let _ = emitter.emit(
                        "tasks-updated",
                        serde_json::json!({ "reason": "foregroundPoll" }),
                    );
                }
                Err(crate::task_foreground_service::TaskForegroundServiceError::Shutdown) => {
                    break;
                }
                Err(error) => {
                    tracing::warn!(?error, "task foreground poll failed");
                }
            }
        }
    });

    Ok(state)
}

#[cfg(test)]
mod notification_tests {
    use super::*;
    use crate::task_foreground_service::{
        TaskForegroundClaimRefusal, TaskForegroundHandoffOutcome,
    };

    #[test]
    fn terminal_notification_policy_is_privacy_safe_and_durable_only() {
        assert!(task_terminal_notification_body(
            TaskNotificationPolicy::None,
            &TaskForegroundHandoffOutcome::CompletedWithAttention,
        )
        .is_none());
        assert!(task_terminal_notification_body(
            TaskNotificationPolicy::AttentionOnly,
            &TaskForegroundHandoffOutcome::Completed,
        )
        .is_none());
        let attention = task_terminal_notification_body(
            TaskNotificationPolicy::AttentionOnly,
            &TaskForegroundHandoffOutcome::CompletedWithAttention,
        )
        .expect("attention terminal should notify");
        let unknown = task_terminal_notification_body(
            TaskNotificationPolicy::AttentionOnly,
            &TaskForegroundHandoffOutcome::OutcomeUnknown {
                code: "bounded-reason".to_string(),
            },
        )
        .expect("durable unknown terminal should notify");
        let completed = task_terminal_notification_body(
            TaskNotificationPolicy::EveryTerminalResult,
            &TaskForegroundHandoffOutcome::Completed,
        )
        .expect("every terminal result should notify");
        assert!(task_terminal_notification_body(
            TaskNotificationPolicy::EveryTerminalResult,
            &TaskForegroundHandoffOutcome::OutcomeUnknownPersistenceFailed(
                TaskForegroundClaimRefusal::StoreUnavailable,
            ),
        )
        .is_none());
        for copy in [attention, unknown, completed] {
            assert!(copy.starts_with("A ShellX Task"));
            assert!(!copy.contains("provider"));
            assert!(!copy.contains('/') && !copy.contains('\\'));
        }
    }
}
