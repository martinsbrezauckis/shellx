// This focused fixture imports complete production modules by path so it can
// exercise their cross-module contract independently of Tauri application
// wiring. APIs outside this fixture's selected scenarios remain intentional.
#![allow(dead_code)]

#[path = "../src/task_execution_runtime.rs"]
mod task_execution_runtime;
#[path = "../src/task_execution_runtime_events.rs"]
mod task_execution_runtime_events;
#[path = "../src/task_execution_runtime_evidence.rs"]
mod task_execution_runtime_evidence;
#[path = "../src/task_provider_fallback.rs"]
mod task_provider_fallback;

// The runtime source uses normal crate-relative provider types. This focused
// integration fixture includes that source as a local module, so mirror the
// production crate path without changing production imports under cfg(test).
mod provider_sessions {
    pub use app_lib::provider_sessions::{
        ProviderEventStatus, ProviderRunPhase, ProviderRunSnapshot, ProviderSessionEvent,
        ProviderSessionEventKind,
    };
}

use app_lib::provider_adapters::ProviderId;
use app_lib::provider_sessions::{
    ProviderEventStatus, ProviderRunSnapshot, ProviderSessionEvent, ProviderSessionEventKind,
};
use task_execution_runtime::*;

fn sha(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

fn plan() -> TaskExecutionPlan {
    TaskExecutionPlan::new(
        TaskExecutionIdentity {
            task_id: "task-1".to_string(),
            revision_id: "revision-1".to_string(),
            revision_sha256: sha('a'),
            occurrence_id: "occurrence-1".to_string(),
            attempt_id: "attempt-1".to_string(),
        },
        TaskExecutionTarget::new(sha('b'), "ssh:host.test:22", "ssh", "posix").unwrap(),
        vec![
            task_provider_fallback::TaskExecutionCandidate::provider_default("grok", 1),
            task_provider_fallback::TaskExecutionCandidate::provider_default("codex-cli", 2),
        ],
    )
    .unwrap()
}

fn catalogue(
    provider_id: &str,
    status: TaskProviderCatalogueStatus,
    can_run: bool,
) -> ExactTaskProviderCatalogueEntry {
    ExactTaskProviderCatalogueEntry {
        schema_version: TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION.to_string(),
        snapshot_id: sha('b'),
        target_key: "ssh:host.test:22".to_string(),
        provider_id: provider_id.to_string(),
        status,
        can_run,
        capability: TaskCapabilityCompatibility::Satisfied,
        generated_at_ms: 150,
        checked_at_ms: 100,
        fresh_until_ms: 200,
        evidence_reference: format!("catalogue:{provider_id}"),
    }
}

#[derive(Default)]
struct RecordingReceiptSink {
    receipts: Vec<TaskExecutionReceiptPayload>,
}

impl TaskExecutionReceiptSink for RecordingReceiptSink {
    type Error = &'static str;

    fn persist_task_execution_receipt(
        &mut self,
        receipt: &TaskExecutionReceiptPayload,
    ) -> Result<(), Self::Error> {
        self.receipts.push(receipt.clone());
        Ok(())
    }
}

struct FailingReceiptSink;

impl TaskExecutionReceiptSink for FailingReceiptSink {
    type Error = &'static str;

    fn persist_task_execution_receipt(
        &mut self,
        _receipt: &TaskExecutionReceiptPayload,
    ) -> Result<(), Self::Error> {
        Err("receipt write failed")
    }
}

#[derive(Default)]
struct RecordingDispatchAdapter {
    preflight_calls: usize,
    dispatch_calls: usize,
    observed_revision_ids: Vec<String>,
    observed_provider_ids: Vec<String>,
}

impl TaskExecutionDispatchAdapter for RecordingDispatchAdapter {
    type Error = &'static str;

    fn run_preflight(
        &mut self,
        plan: TaskProviderPreflightPlan,
    ) -> Result<ExactTaskProviderCatalogueEntry, Self::Error> {
        self.preflight_calls += 1;
        self.observed_revision_ids
            .push(plan.identity().revision_id.clone());
        self.observed_provider_ids
            .push(plan.candidate().provider_id.clone());
        Ok(catalogue(
            plan.candidate().provider_id.as_str(),
            TaskProviderCatalogueStatus::Ready,
            true,
        ))
    }

    fn dispatch_provider(
        &mut self,
        plan: TaskProviderDispatchPlan,
    ) -> Result<TaskDispatchObservation, Self::Error> {
        self.dispatch_calls += 1;
        self.observed_revision_ids
            .push(plan.identity().revision_id.clone());
        self.observed_provider_ids
            .push(plan.candidate().provider_id.clone());
        Ok(TaskDispatchObservation::Accepted {
            evidence_reference: "adapter:accepted".to_string(),
        })
    }
}

fn persist(
    transition: PendingTaskExecutionTransition<'_>,
    sink: &mut RecordingReceiptSink,
) -> PersistedTaskExecutionAction {
    transition.persist(sink).unwrap().into_action()
}

fn reject_receipt(transition: PendingTaskExecutionTransition<'_>) {
    let mut sink = FailingReceiptSink;
    assert!(matches!(
        transition.persist(&mut sink),
        Err("receipt write failed")
    ));
}

fn start_dispatch(runtime: &mut TaskExecutionRuntime, sink: &mut RecordingReceiptSink) {
    assert!(matches!(
        persist(runtime.begin("lease:1").unwrap(), sink),
        PersistedTaskExecutionAction::RunPreflight(_)
    ));
    assert!(matches!(
        persist(
            runtime
                .apply_catalogue_preflight(
                    catalogue("grok", TaskProviderCatalogueStatus::Ready, true),
                    150,
                )
                .unwrap(),
            sink,
        ),
        PersistedTaskExecutionAction::DispatchProvider(_)
    ));
}

#[test]
fn immutable_dispatch_plan_is_exposed_only_after_receipt_persistence() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();

    let pending = runtime.begin("lease:1").unwrap();
    assert_eq!(pending.receipt().identity.revision_id, "revision-1");
    assert_eq!(pending.receipt().target.catalogue_snapshot_id, sha('b'));
    assert_eq!(sink.receipts.len(), 0);

    let action = persist(pending, &mut sink);
    assert_eq!(sink.receipts.len(), 1);
    let PersistedTaskExecutionAction::RunPreflight(preflight) = action else {
        panic!("candidate selection must request preflight after persistence")
    };
    assert_eq!(preflight.identity().revision_sha256, sha('a'));
    assert_eq!(preflight.target().key, "ssh:host.test:22");
    assert_eq!(preflight.candidate().provider_id, "grok");
}

#[test]
fn failed_begin_receipt_leaves_runtime_ready_and_allows_a_safe_retry() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    reject_receipt(runtime.begin("lease:1").unwrap());
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::Ready
    );

    let mut sink = RecordingReceiptSink::default();
    assert!(matches!(
        persist(runtime.begin("lease:1").unwrap(), &mut sink),
        PersistedTaskExecutionAction::RunPreflight(_)
    ));
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight
    );
}

#[test]
fn failed_eligible_preflight_receipt_does_not_mark_the_candidate_dispatched() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    let _ = persist(runtime.begin("lease:1").unwrap(), &mut sink);

    reject_receipt(
        runtime
            .apply_catalogue_preflight(
                catalogue("grok", TaskProviderCatalogueStatus::Ready, true),
                150,
            )
            .unwrap(),
    );
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight
    );

    assert!(matches!(
        persist(
            runtime
                .apply_catalogue_preflight(
                    catalogue("grok", TaskProviderCatalogueStatus::Ready, true),
                    150,
                )
                .unwrap(),
            &mut sink,
        ),
        PersistedTaskExecutionAction::DispatchProvider(_)
    ));
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingDispatch
    );
}

#[test]
fn failed_fallback_receipt_does_not_advance_to_the_next_candidate() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    let _ = persist(runtime.begin("lease:1").unwrap(), &mut sink);

    reject_receipt(
        runtime
            .apply_catalogue_preflight(
                catalogue("grok", TaskProviderCatalogueStatus::Missing, false),
                150,
            )
            .unwrap(),
    );
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight
    );

    assert!(matches!(
        persist(
            runtime
                .apply_catalogue_preflight(
                    catalogue("grok", TaskProviderCatalogueStatus::Missing, false),
                    150,
                )
                .unwrap(),
            &mut sink,
        ),
        PersistedTaskExecutionAction::RunPreflight(ref plan)
            if plan.candidate().provider_id == "codex-cli"
    ));
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight
    );
}

#[test]
fn failed_committed_start_receipt_leaves_dispatch_retryable() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    start_dispatch(&mut runtime, &mut sink);

    reject_receipt(
        runtime
            .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                evidence_reference: "provider:accepted".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::AwaitingDispatch
    );

    assert!(matches!(
        persist(
            runtime
                .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                    evidence_reference: "provider:accepted".to_string(),
                })
                .unwrap(),
            &mut sink,
        ),
        PersistedTaskExecutionAction::CommittedStartRecorded
    ));
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::Active
    );
}

#[test]
fn failed_terminal_receipt_leaves_active_runtime_retryable() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    start_dispatch(&mut runtime, &mut sink);
    let _ = persist(
        runtime
            .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                evidence_reference: "provider:accepted".to_string(),
            })
            .unwrap(),
        &mut sink,
    );
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::Active
    );

    reject_receipt(runtime.observe_timeout("scheduler:timeout").unwrap());
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::Active
    );

    assert!(matches!(
        persist(
            runtime.observe_timeout("scheduler:timeout").unwrap(),
            &mut sink,
        ),
        PersistedTaskExecutionAction::Notify(TaskExecutionNotification {
            kind: TaskExecutionNotificationKind::NeedsAttention,
            ..
        })
    ));
    assert_eq!(
        runtime.phase(),
        task_provider_fallback::ExecutionPhaseKind::NeedsAttention
    );
}

#[test]
fn snapshot_identity_is_exact_and_revision_hashes_normalize_for_receipts() {
    assert!(matches!(
        TaskExecutionTarget::new(
            format!("sha256:{}", "A".repeat(64)),
            "local",
            "local",
            "native"
        ),
        Err(TaskExecutionPlanError::InvalidCatalogueSnapshotId)
    ));
    assert!(matches!(
        TaskExecutionTarget::new("a".repeat(64), "local", "local", "native"),
        Err(TaskExecutionPlanError::InvalidCatalogueSnapshotId)
    ));

    let normalized = TaskExecutionPlan::new(
        TaskExecutionIdentity {
            task_id: "task-1".to_string(),
            revision_id: "revision-1".to_string(),
            revision_sha256: "A".repeat(64),
            occurrence_id: "occurrence-1".to_string(),
            attempt_id: "attempt-1".to_string(),
        },
        TaskExecutionTarget::new(sha('b'), "local", "local", "native").unwrap(),
        vec![task_provider_fallback::TaskExecutionCandidate::provider_default("grok", 1)],
    )
    .unwrap();
    assert_eq!(normalized.identity().revision_sha256, sha('a'));
}

#[test]
fn persisted_identifiers_targets_and_evidence_reject_control_or_oversize_values() {
    let mut identity = plan().identity().clone();
    identity.task_id = format!("task-{}", "x".repeat(300));
    assert!(matches!(
        TaskExecutionPlan::new(
            identity,
            TaskExecutionTarget::new(sha('b'), "local", "local", "native").unwrap(),
            vec![task_provider_fallback::TaskExecutionCandidate::provider_default("grok", 1,)],
        ),
        Err(TaskExecutionPlanError::MissingIdentity("task_id"))
    ));
    assert!(matches!(
        TaskExecutionTarget::new(sha('b'), "local\npath", "local", "native"),
        Err(TaskExecutionPlanError::MissingTargetIdentity)
    ));

    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    assert!(matches!(
        runtime.begin("bad\nreceipt-reference"),
        Err(TaskExecutionRuntimeError::InvalidEvidenceReference)
    ));
    assert!(matches!(
        runtime.begin("x".repeat(513)),
        Err(TaskExecutionRuntimeError::InvalidEvidenceReference)
    ));

    let mut oversized_event = provider_event(ProviderSessionEventKind::Started);
    oversized_event.run_id = "r".repeat(201);
    assert!(matches!(
        classify_provider_session_event(&oversized_event),
        TaskProviderSessionObservation::None
    ));
}

#[test]
fn adapter_receives_the_exact_revision_candidate_and_target_only_after_persist() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    let mut adapter = RecordingDispatchAdapter::default();

    let persisted = runtime
        .begin("lease:1")
        .unwrap()
        .persist(&mut sink)
        .unwrap();
    assert_eq!(adapter.preflight_calls, 0);
    let TaskExecutionAdapterResult::Preflight(entry) =
        execute_persisted_action(persisted.into_action(), &mut adapter)
            .unwrap()
            .unwrap()
    else {
        panic!("persisted selection should request an exact provider catalogue preflight")
    };
    assert_eq!(adapter.preflight_calls, 1);
    assert_eq!(adapter.dispatch_calls, 0);
    assert_eq!(adapter.observed_revision_ids, ["revision-1"]);
    assert_eq!(adapter.observed_provider_ids, ["grok"]);

    let persisted = runtime
        .apply_catalogue_preflight(entry, 150)
        .unwrap()
        .persist(&mut sink)
        .unwrap();
    let TaskExecutionAdapterResult::Dispatch(TaskDispatchObservation::Accepted { .. }) =
        execute_persisted_action(persisted.into_action(), &mut adapter)
            .unwrap()
            .unwrap()
    else {
        panic!("persisted eligible preflight should dispatch the existing provider runtime")
    };
    assert_eq!(adapter.dispatch_calls, 1);
    assert_eq!(adapter.observed_revision_ids, ["revision-1", "revision-1"]);
    assert_eq!(adapter.observed_provider_ids, ["grok", "grok"]);
}

#[test]
fn exact_catalogue_statuses_authorize_only_typed_pre_effect_fallback() {
    let cases = [
        (TaskProviderCatalogueStatus::Missing, false),
        (TaskProviderCatalogueStatus::VersionFailed, false),
        (TaskProviderCatalogueStatus::IdentityFailed, false),
        (TaskProviderCatalogueStatus::TargetUnavailable, false),
        (TaskProviderCatalogueStatus::AuthNeeded, false),
        (TaskProviderCatalogueStatus::CanaryFailed, false),
    ];

    for (status, can_run) in cases {
        let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
        let mut sink = RecordingReceiptSink::default();
        let _ = persist(runtime.begin("lease:1").unwrap(), &mut sink);
        let next = runtime
            .apply_catalogue_preflight(catalogue("grok", status, can_run), 150)
            .unwrap();
        assert!(matches!(
            persist(next, &mut sink),
            PersistedTaskExecutionAction::RunPreflight(ref next) if next.candidate().provider_id == "codex-cli"
        ));
        assert_eq!(
            runtime.phase(),
            task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight
        );
    }
}

#[test]
fn stale_mismatched_unknown_or_contradictory_catalogues_need_attention_not_fallback() {
    let mut cases = vec![
        catalogue("grok", TaskProviderCatalogueStatus::Unknown, false),
        catalogue("grok", TaskProviderCatalogueStatus::Ready, false),
    ];
    let mut stale = catalogue("grok", TaskProviderCatalogueStatus::Missing, false);
    stale.fresh_until_ms = 149;
    cases.push(stale);
    let mut wrong_target = catalogue("grok", TaskProviderCatalogueStatus::Missing, false);
    wrong_target.target_key = "local".to_string();
    cases.push(wrong_target);
    let mut wrong_schema = catalogue("grok", TaskProviderCatalogueStatus::Missing, false);
    wrong_schema.schema_version = "shellx.provider-capability-snapshot.v2".to_string();
    cases.push(wrong_schema);
    let mut unsafe_evidence = catalogue("grok", TaskProviderCatalogueStatus::Missing, false);
    unsafe_evidence.evidence_reference = "invalid\nreference".to_string();
    cases.push(unsafe_evidence);

    for entry in cases {
        let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
        let mut sink = RecordingReceiptSink::default();
        let _ = persist(runtime.begin("lease:1").unwrap(), &mut sink);
        let terminal = runtime.apply_catalogue_preflight(entry, 150).unwrap();
        assert_eq!(
            terminal.receipt().notification.kind,
            TaskExecutionNotificationKind::NeedsAttention
        );
        assert!(terminal.receipt().decision.evidence.reference.len() <= 512);
        assert!(!terminal
            .receipt()
            .decision
            .evidence
            .reference
            .chars()
            .any(char::is_control));
        assert!(matches!(
            persist(terminal, &mut sink),
            PersistedTaskExecutionAction::Notify(TaskExecutionNotification {
                kind: TaskExecutionNotificationKind::NeedsAttention,
                ..
            })
        ));
        assert_eq!(
            runtime.phase(),
            task_provider_fallback::ExecutionPhaseKind::NeedsAttention
        );
    }
}

#[test]
fn structured_rejection_can_fallback_but_ambiguous_post_dispatch_cannot() {
    for observation in [
        TaskDispatchObservation::StructuredRejectedNoTaskStarted {
            reason: StructuredNoTaskStartReason::RateLimited,
            evidence_reference: "provider:rate-limited".to_string(),
        },
        TaskDispatchObservation::StructuredRejectedNoTaskStarted {
            reason: StructuredNoTaskStartReason::Unavailable,
            evidence_reference: "provider:unavailable".to_string(),
        },
    ] {
        let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
        let mut sink = RecordingReceiptSink::default();
        start_dispatch(&mut runtime, &mut sink);
        assert!(matches!(
            persist(runtime.apply_dispatch_observation(observation).unwrap(), &mut sink),
            PersistedTaskExecutionAction::RunPreflight(ref next) if next.candidate().provider_id == "codex-cli"
        ));
    }

    for observation in [
        TaskDispatchObservation::TransportLostAfterPromptDispatch {
            evidence_reference: "provider:lost".to_string(),
        },
        TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
            evidence_reference: "provider:unexpected".to_string(),
        },
    ] {
        let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
        let mut sink = RecordingReceiptSink::default();
        start_dispatch(&mut runtime, &mut sink);
        let terminal = runtime.apply_dispatch_observation(observation).unwrap();
        assert!(matches!(
            persist(terminal, &mut sink),
            PersistedTaskExecutionAction::Notify(_)
        ));
        assert!(matches!(
            runtime.phase(),
            task_provider_fallback::ExecutionPhaseKind::NeedsAttention
                | task_provider_fallback::ExecutionPhaseKind::OutcomeUnknown
        ));
    }
}

fn provider_event(kind: ProviderSessionEventKind) -> ProviderSessionEvent {
    ProviderSessionEvent {
        schema_version: 1,
        event_id: "provider-event-1".to_string(),
        sequence: 1,
        occurred_at_ms: 1,
        run_id: "provider-run-1".to_string(),
        tab_id: "task-tab-1".to_string(),
        provider_id: ProviderId::CodexCli,
        kind,
        status: None,
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
        capabilities: vec![],
        target: None,
        text: None,
        raw_type: None,
        exit_code: None,
        error: None,
        provider_conversation_id: None,
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        usage: None,
        artifacts: vec![],
        raw_reference: None,
    }
}

#[test]
fn provider_session_structured_content_effect_and_terminal_events_are_receipt_ready() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    start_dispatch(&mut runtime, &mut sink);
    let _ = persist(
        runtime
            .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                evidence_reference: "provider:accepted".to_string(),
            })
            .unwrap(),
        &mut sink,
    );

    let mut text = provider_event(ProviderSessionEventKind::TextDelta);
    text.text = Some("work has started".to_string());
    assert!(matches!(
        persist(
            runtime
                .observe_provider_session_event(&text)
                .unwrap()
                .unwrap(),
            &mut sink,
        ),
        PersistedTaskExecutionAction::CommittedStartRecorded
    ));

    let file_change = provider_event(ProviderSessionEventKind::FileChange);
    assert!(matches!(
        classify_provider_session_event(&file_change),
        TaskProviderSessionObservation::Active(
            task_provider_fallback::ActiveProviderSignal::PossibleExternalEffect { .. }
        )
    ));

    let completed = provider_event(ProviderSessionEventKind::Completed);
    let terminal = runtime
        .observe_provider_session_event(&completed)
        .unwrap()
        .unwrap();
    assert_eq!(
        terminal.receipt().notification.kind,
        TaskExecutionNotificationKind::Completed
    );
    assert!(matches!(
        persist(terminal, &mut sink),
        PersistedTaskExecutionAction::Notify(TaskExecutionNotification {
            kind: TaskExecutionNotificationKind::Completed,
            ..
        })
    ));
}

#[test]
fn repeated_provider_activity_is_coalesced_to_one_receipt_per_semantic_milestone() {
    let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
    let mut sink = RecordingReceiptSink::default();
    start_dispatch(&mut runtime, &mut sink);
    let _ = persist(
        runtime
            .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                evidence_reference: "provider:accepted".to_string(),
            })
            .unwrap(),
        &mut sink,
    );

    let running = serde_json::json!({
        "method": "session/update",
        "params": {"update": {"sessionUpdate": "agent_thought_chunk"}}
    });
    let content = serde_json::json!({
        "method": "session/update",
        "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "activity"}}}
    });
    for index in 0..100 {
        let transition = runtime
            .observe_grok_acp_event(&running, format!("acp:running:{index}"))
            .unwrap();
        if let Some(transition) = transition {
            let _ = persist(transition, &mut sink);
        }
    }
    for index in 0..100 {
        let transition = runtime
            .observe_grok_acp_event(&content, format!("acp:content:{index}"))
            .unwrap();
        if let Some(transition) = transition {
            let _ = persist(transition, &mut sink);
        }
    }

    let completed = serde_json::json!({
        "method": "_x.ai/session/prompt_complete",
        "params": {"stopReason": "completed"}
    });
    let terminal = runtime
        .observe_grok_acp_event(&completed, "acp:terminal")
        .unwrap()
        .unwrap();
    let _ = persist(terminal, &mut sink);

    assert_eq!(sink.receipts.len(), 6);
    let activity = sink
        .receipts
        .iter()
        .filter(|receipt| {
            matches!(
                receipt.decision.reason,
                task_provider_fallback::ProviderRouteDecisionReason::ProviderActivity(_)
            )
        })
        .count();
    assert_eq!(activity, 2);
}

#[test]
fn provider_session_approval_and_snapshot_lifecycle_are_structured_boundaries() {
    let mut event = provider_event(ProviderSessionEventKind::Raw);
    event.status = Some(ProviderEventStatus::WaitingForApproval);
    assert!(matches!(
        classify_provider_session_event(&event),
        TaskProviderSessionObservation::Active(
            task_provider_fallback::ActiveProviderSignal::ToolOrApproval { .. }
        )
    ));

    let run: ProviderRunSnapshot = serde_json::from_value(serde_json::json!({
        "runId": "provider-run-1",
        "tabId": "task-tab-1",
        "providerId": "codex-cli",
        "cwd": "/not/exposed/to/receipt",
        "transport": "local",
        "transportKey": "local",
        "phase": "streaming",
        "promptPreview": "not exposed",
        "startedAtMs": 1,
        "updatedAtMs": 2,
        "stdoutLineCount": 0,
        "stderrLineCount": 0,
        "persistSession": true,
        "permissionMode": "readOnly",
        "shellxToolExposure": "off"
    }))
    .unwrap();
    assert!(matches!(
        classify_provider_run_snapshot(&run, "snapshot:1"),
        TaskProviderSessionObservation::Active(
            task_provider_fallback::ActiveProviderSignal::Running { .. }
        )
    ));
}

#[test]
fn grok_acp_structured_tool_content_and_terminal_events_never_use_message_text_for_fallback() {
    let content = serde_json::json!({
        "method": "session/update",
        "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "started"}}}
    });
    assert!(matches!(
        classify_grok_acp_event(&content, "acp:content"),
        TaskGrokAcpObservation::Active(
            task_provider_fallback::ActiveProviderSignal::FirstTaskContent { .. }
        )
    ));
    let tool = serde_json::json!({
        "method": "session/update",
        "params": {"update": {"sessionUpdate": "tool_call_update", "status": "completed"}}
    });
    assert!(matches!(
        classify_grok_acp_event(&tool, "acp:tool"),
        TaskGrokAcpObservation::Active(
            task_provider_fallback::ActiveProviderSignal::ToolOrApproval { .. }
        )
    ));
    let unknown_terminal = serde_json::json!({
        "method": "_x.ai/session/prompt_complete",
        "params": {"stopReason": "new_provider_reason", "agentResult": "rate limited"}
    });
    assert!(matches!(
        classify_grok_acp_event(&unknown_terminal, "acp:terminal"),
        TaskGrokAcpObservation::Outcome(
            task_provider_fallback::ActiveProviderOutcome::OutcomeUnknown { .. }
        )
    ));
}

#[test]
fn cancellation_and_timeout_stop_the_route_and_emit_attention_notifications() {
    for timeout in [false, true] {
        let mut runtime = TaskExecutionRuntime::new(plan()).unwrap();
        let mut sink = RecordingReceiptSink::default();
        start_dispatch(&mut runtime, &mut sink);
        let _ = persist(
            runtime
                .apply_dispatch_observation(TaskDispatchObservation::Accepted {
                    evidence_reference: "provider:accepted".to_string(),
                })
                .unwrap(),
            &mut sink,
        );
        let terminal = if timeout {
            runtime.observe_timeout("scheduler:timeout").unwrap()
        } else {
            runtime.observe_cancellation("operator:cancel").unwrap()
        };
        assert_eq!(
            terminal.receipt().notification.kind,
            TaskExecutionNotificationKind::NeedsAttention
        );
        let _ = persist(terminal, &mut sink);
        assert_eq!(
            runtime.phase(),
            task_provider_fallback::ExecutionPhaseKind::NeedsAttention
        );
    }
}
