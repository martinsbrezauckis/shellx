use super::*;
use crate::provider_sessions::{ProviderSessionEmit, ProviderSessionRegistry};
use crate::task_execution_runtime::{
    ExactTaskProviderCatalogueEntry, TaskCapabilityCompatibility, TaskExecutionPlan,
    TaskExecutionReceiptPayload, TaskExecutionReceiptSink, TaskExecutionTarget,
    TaskProviderCatalogueStatus,
};
use crate::task_provider_fallback::{ModelSelection, TaskExecutionCandidate};

const NOW: i64 = 1_800_000_000_000;

fn plan() -> TaskExecutionPlan {
    TaskExecutionPlan::new(
        TaskExecutionIdentity {
            task_id: "task-runtime-test".to_string(),
            revision_id: "revision-runtime-test".to_string(),
            revision_sha256: "a".repeat(64),
            occurrence_id: "occurrence-runtime-test".to_string(),
            attempt_id: "attempt-runtime-test".to_string(),
        },
        TaskExecutionTarget::new(
            format!("sha256:{}", "b".repeat(64)),
            "local:linux",
            "local",
            "posix",
        )
        .unwrap(),
        vec![TaskExecutionCandidate {
            provider_id: "grok".to_string(),
            model: ModelSelection::ProviderDefault,
            order: 1,
        }],
    )
    .unwrap()
}

fn ready_catalogue_entry(plan: &TaskExecutionPlan) -> ExactTaskProviderCatalogueEntry {
    ExactTaskProviderCatalogueEntry {
        schema_version: crate::task_execution_runtime::TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION
            .to_string(),
        snapshot_id: plan.target().catalogue_snapshot_id.clone(),
        target_key: plan.target().key.clone(),
        provider_id: "grok".to_string(),
        status: TaskProviderCatalogueStatus::Ready,
        can_run: true,
        capability: TaskCapabilityCompatibility::Satisfied,
        generated_at_ms: NOW - 1,
        checked_at_ms: NOW - 1,
        fresh_until_ms: NOW + 60_000,
        evidence_reference: "task-catalogue:ready".to_string(),
    }
}

#[derive(Default)]
struct RecordingSink {
    receipts: Vec<TaskExecutionReceiptPayload>,
    reject: bool,
}

#[derive(Default)]
struct FakeGrokStarter {
    live_task_tabs: Mutex<BTreeSet<String>>,
}

impl FakeGrokStarter {
    fn start_for_test(&self, task_tab_id: &str) -> bool {
        self.live_task_tabs
            .lock()
            .unwrap()
            .insert(task_tab_id.to_string())
    }

    fn is_live(&self, task_tab_id: &str) -> bool {
        self.live_task_tabs.lock().unwrap().contains(task_tab_id)
    }
}

impl TaskRuntimeGrokSessionStarter for FakeGrokStarter {
    fn prepare_fresh_grok_session<'a>(
        &'a self,
        _context: TaskGrokSessionStartContext,
        _events: TaskGrokAcpEventBuffer,
    ) -> TaskRuntimeFuture<'a, TaskRuntimeGrokPreparation> {
        Box::pin(async { TaskRuntimeGrokPreparation::Ready })
    }

    fn cleanup_task_tab<'a>(
        &'a self,
        task_tab_id: String,
    ) -> TaskRuntimeFuture<'a, Result<(), TaskRuntimeGrokCleanupError>> {
        Box::pin(async move {
            self.live_task_tabs.lock().unwrap().remove(&task_tab_id);
            Ok(())
        })
    }
}

impl TaskExecutionReceiptSink for RecordingSink {
    type Error = ();

    fn persist_task_execution_receipt(
        &mut self,
        receipt: &TaskExecutionReceiptPayload,
    ) -> Result<(), Self::Error> {
        if self.reject {
            return Err(());
        }
        self.receipts.push(receipt.clone());
        Ok(())
    }
}

#[test]
fn failed_persistence_keeps_the_runtime_ready_before_any_effect() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingSink {
        reject: true,
        ..RecordingSink::default()
    };
    assert!(runtime
        .begin("task-lease:test")
        .unwrap()
        .persist(&mut sink)
        .is_err());
    assert_eq!(
        runtime.phase(),
        crate::task_provider_fallback::ExecutionPhaseKind::Ready
    );
    assert!(sink.receipts.is_empty());
}

#[test]
fn cancellation_is_scoped_to_each_concurrent_occurrence_attempt() {
    let cancellation = TaskRuntimeCancellation::default();
    let first = plan().identity().clone();
    let mut second = first.clone();
    second.occurrence_id = "occurrence-runtime-test-2".to_string();
    second.attempt_id = "attempt-runtime-test-2".to_string();
    cancellation.activate(&first).unwrap();
    cancellation.activate(&second).unwrap();

    assert!(cancellation.request(&first.occurrence_id, &first.attempt_id));
    assert!(cancellation.is_requested(&first));
    assert!(!cancellation.is_requested(&second));
    assert!(cancellation.request(&second.occurrence_id, &second.attempt_id));
    assert!(cancellation.is_requested(&second));
    cancellation.deactivate(&first);
    assert!(!cancellation.request(&first.occurrence_id, &first.attempt_id));
    assert!(cancellation.is_requested(&second));
}

#[test]
fn timeout_and_cancellation_are_persisted_before_known_attention_terminal() {
    for timeout in [true, false] {
        let plan = plan();
        let mut runtime = TaskExecutionRuntime::new(plan.clone()).unwrap();
        let mut sink = RecordingSink::default();
        let action = runtime
            .begin("task-lease:test")
            .unwrap()
            .persist(&mut sink)
            .unwrap()
            .into_action();
        let preflight = match action {
            PersistedTaskExecutionAction::RunPreflight(_) => ready_catalogue_entry(&plan),
            _ => unreachable!(),
        };
        let action = runtime
            .apply_catalogue_preflight(preflight, NOW)
            .unwrap()
            .persist(&mut sink)
            .unwrap()
            .into_action();
        assert!(matches!(
            action,
            PersistedTaskExecutionAction::DispatchProvider(_)
        ));
        let action = runtime
            .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                evidence_reference: "task-provider:accepted".to_string(),
            })
            .unwrap()
            .persist(&mut sink)
            .unwrap()
            .into_action();
        assert!(matches!(
            action,
            PersistedTaskExecutionAction::CommittedStartRecorded
        ));
        let action = if timeout {
            runtime.observe_timeout("task-runtime-timeout")
        } else {
            runtime.observe_cancellation("task-runtime-cancel-request")
        }
        .unwrap()
        .persist(&mut sink)
        .unwrap()
        .into_action();
        assert!(matches!(action, PersistedTaskExecutionAction::Notify(_)));
        assert_eq!(sink.receipts.len(), 4);
        assert!(matches!(
            terminal_action(action).unwrap(),
            TaskForegroundRunnerResult::CompletedWithAttention
        ));
    }
}

#[test]
fn committed_activity_is_not_treated_as_terminal() {
    assert!(matches!(
        active_action(PersistedTaskExecutionAction::CommittedStartRecorded).unwrap(),
        ActiveAction::Continue
    ));
}

#[test]
fn running_content_and_success_are_all_durable_before_completed() {
    let plan = plan();
    let mut runtime = TaskExecutionRuntime::new(plan.clone()).unwrap();
    let mut sink = RecordingSink::default();
    let preflight = match runtime
        .begin("task-lease:test")
        .unwrap()
        .persist(&mut sink)
        .unwrap()
        .into_action()
    {
        PersistedTaskExecutionAction::RunPreflight(_) => ready_catalogue_entry(&plan),
        _ => unreachable!(),
    };
    runtime
        .apply_catalogue_preflight(preflight, NOW)
        .unwrap()
        .persist(&mut sink)
        .unwrap();
    runtime
        .apply_dispatch_observation(TaskDispatchObservation::Accepted {
            evidence_reference: "task-provider:accepted".to_string(),
        })
        .unwrap()
        .persist(&mut sink)
        .unwrap();

    for payload in [
        serde_json::json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_thought_chunk" } }
        }),
        serde_json::json!({
            "method": "session/update",
            "params": { "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "activity" }
            } }
        }),
        serde_json::json!({
            "method": "_x.ai/session/prompt_complete",
            "params": { "stopReason": "completed" }
        }),
    ] {
        let action = runtime
            .observe_grok_acp_event(&payload, "task-grok-acp:test:event")
            .unwrap()
            .unwrap()
            .persist(&mut sink)
            .unwrap()
            .into_action();
        match active_action(action).unwrap() {
            ActiveAction::Continue => {}
            ActiveAction::Terminal(result) => {
                assert!(matches!(result, TaskForegroundRunnerResult::Completed))
            }
        }
    }
    assert_eq!(sink.receipts.len(), 6);
    assert_eq!(
        runtime.phase(),
        crate::task_provider_fallback::ExecutionPhaseKind::Completed
    );
}

#[test]
fn unclassified_post_prompt_dispatch_is_outcome_unknown() {
    let plan = plan();
    let mut runtime = TaskExecutionRuntime::new(plan.clone()).unwrap();
    let mut sink = RecordingSink::default();
    let preflight = match runtime
        .begin("task-lease:test")
        .unwrap()
        .persist(&mut sink)
        .unwrap()
        .into_action()
    {
        PersistedTaskExecutionAction::RunPreflight(_) => ready_catalogue_entry(&plan),
        _ => unreachable!(),
    };
    runtime
        .apply_catalogue_preflight(preflight, NOW)
        .unwrap()
        .persist(&mut sink)
        .unwrap();
    let action = runtime
        .apply_dispatch_observation(
            TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
                evidence_reference: "task-provider:dispatch-uncertain".to_string(),
            },
        )
        .unwrap()
        .persist(&mut sink)
        .unwrap()
        .into_action();
    assert!(matches!(
        terminal_action(action).unwrap(),
        TaskForegroundRunnerResult::OutcomeUnknown { .. }
    ));
}

#[tokio::test]
async fn durable_grok_cleanup_releases_the_exact_tab_for_a_repeated_attempt() {
    let starter = Arc::new(FakeGrokStarter::default());
    let task_tab_id = "task-run-repeat-attempt";
    assert!(starter.start_for_test(task_tab_id));
    let emit: ProviderSessionEmit = Arc::new(|_, _| {});
    let dispatcher = TaskRuntimeProviderDispatcher::new(
        TaskExternalProviderRuntime::new(Arc::new(ProviderSessionRegistry::default()), emit),
        TaskGrokAcpRuntime::new(Arc::new(crate::acp::SessionRegistry::new())),
        starter.clone(),
    );

    dispatcher
        .cleanup_grok_after_receipt(Some(task_tab_id.to_string()))
        .await
        .unwrap();
    assert!(!starter.is_live(task_tab_id));
    assert!(starter.start_for_test(task_tab_id));
}
