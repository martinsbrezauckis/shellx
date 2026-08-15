use super::*;
use crate::connections::ConnectionProviderCapabilityTarget;
use crate::task_model::{
    TaskConcurrencyPolicy, TaskEnvironmentSnapshot, TaskExecutionCandidate as StoredCandidate,
    TaskExecutionPolicy, TaskLocalTime, TaskMissedRunPolicy, TaskNotificationPolicy,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_provider_catalog::{
    TaskProviderAvailability, TaskProviderCatalogProvider, TaskProviderDefaultModelMode,
};
use crate::task_provider_fallback::{DecisionEvidence, PreEffectRejectionReason};

const NOW: i64 = 1_800_000_000_000;

fn test_clock() -> i64 {
    NOW
}

fn snapshot_id(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

fn draft() -> crate::task_model::TaskDraft {
    crate::task_model::TaskDraft {
        name: "Daily report".to_string(),
        instruction: "Inspect and summarize.".to_string(),
        success_criteria: None,
        no_change_criteria: None,
        environment: TaskEnvironmentSnapshot {
            connection_id: "local".to_string(),
            snapshot_id: snapshot_id('a'),
            target_key: "local:linux".to_string(),
            canonical_cwd: "/workspace".to_string(),
            project_id: None,
        },
        candidates: vec![StoredCandidate {
            order: 1,
            provider_id: "grok".to_string(),
            model: TaskModelSelection::ProviderDefault,
            capability_requirements: Vec::new(),
            option_refs: Vec::new(),
        }],
        execution_policy: TaskExecutionPolicy {
            permission_mode: "default".to_string(),
            autonomy_mode: "default".to_string(),
            tool_exposure_ids: vec!["nativeFirst".to_string()],
        },
        attachment_refs: Vec::new(),
        workflow: None,
        vault_requirements: Vec::new(),
        trigger: TaskTrigger::Daily {
            at: TaskLocalTime { hour: 9, minute: 0 },
        },
        timezone: "Europe/Riga".to_string(),
        missed_run_policy: TaskMissedRunPolicy::Skip,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 60,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts: 16 },
        origin: None,
    }
}

fn catalogue() -> TaskProviderCatalog {
    TaskProviderCatalog {
        schema_version: TASK_PROVIDER_CATALOG_SCHEMA_VERSION.to_string(),
        // The task's saved scan is historical provenance (`a`); every
        // occurrence must bind to this separate fresh scan (`b`).
        snapshot_id: snapshot_id('b'),
        generated_at_ms: NOW - 1_000,
        fresh_until_ms: NOW - 1_000 + TASK_PROVIDER_CATALOG_TTL_MS,
        target: ConnectionProviderCapabilityTarget {
            key: "local:linux".to_string(),
            transport: "local".to_string(),
            runtime: "posix".to_string(),
            label: "Local Linux".to_string(),
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
        },
        providers: PROVIDER_IDS
            .iter()
            .map(|provider_id| TaskProviderCatalogProvider {
                provider_id: (*provider_id).to_string(),
                label: (*provider_id).to_string(),
                availability: TaskProviderAvailability {
                    status: ConnectionProviderScanStatus::Ready,
                    can_run: true,
                    version: Some("1.0.0".to_string()),
                    detail: String::new(),
                    checked_at_ms: NOW - 1_001,
                },
                capability_guidance: Vec::new(),
                models: Vec::new(),
                default_model_mode: TaskProviderDefaultModelMode::ProviderDefault,
            })
            .collect(),
    }
}

fn claimed_binding_with(
    task_draft: crate::task_model::TaskDraft,
) -> (tempfile::TempDir, TaskStore, TaskExecutionStoreBinding) {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(task_draft, false, NOW - 10_000).unwrap();
    let occurrence = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            NOW - 5_000,
            NOW - 4_000,
        )
        .unwrap();
    store
        .claim_occurrence(&occurrence.occurrence_id, "runner-1", 60_000, NOW - 3_000)
        .unwrap();
    let binding = TaskExecutionStoreBinding::load(
        &store,
        &occurrence.occurrence_id,
        "runner-1",
        &catalogue(),
        NOW,
    )
    .unwrap();
    (directory, store, binding)
}

fn claimed_binding() -> (tempfile::TempDir, TaskStore, TaskExecutionStoreBinding) {
    claimed_binding_with(draft())
}

fn decision(reason: ProviderRouteDecisionReason) -> ProviderRouteDecision {
    ProviderRouteDecision {
        candidate: TaskExecutionCandidate::provider_default("grok", 1),
        reason,
        evidence: DecisionEvidence::new(EvidenceClass::ProviderAdapter, "adapter:result"),
        transition: crate::task_provider_fallback::ExecutionTransition {
            from: crate::task_provider_fallback::ExecutionPhaseKind::AwaitingPreflight,
            to: crate::task_provider_fallback::ExecutionPhaseKind::NeedsAttention,
        },
    }
}

#[test]
fn claimed_binding_uses_current_scan_not_saved_snapshot_and_rejects_stale_catalogue() {
    let (_directory, store, binding) = claimed_binding();
    let (occurrence, revision) = store.get_execution_binding(&binding.occurrence_id).unwrap();
    assert_eq!(binding.plan().identity().task_id, occurrence.task_id);
    assert_eq!(binding.plan().identity().revision_id, revision.revision_id);
    assert_eq!(
        binding.plan().identity().attempt_id,
        occurrence.active_lease.unwrap().attempt_id
    );
    assert_eq!(
        binding.plan().target().catalogue_snapshot_id,
        snapshot_id('b')
    );
    assert_eq!(binding.plan().target().key, "local:linux");

    let mut stale = catalogue();
    stale.fresh_until_ms = NOW - 1;
    assert!(matches!(
        TaskExecutionStoreBinding::load(&store, &binding.occurrence_id, "runner-1", &stale, NOW,),
        Err(TaskExecutionStoreAdapterError::CatalogueFreshness)
    ));
}

#[test]
fn receipt_write_failure_keeps_runtime_retryable_and_writes_nothing() {
    let (_directory, store, binding) = claimed_binding();
    let receipt_count_before = store
        .list_receipts(&binding.plan().identity().task_id, 16)
        .unwrap()
        .len();
    let mut runtime =
        crate::task_execution_runtime::TaskExecutionRuntime::new(binding.plan().clone()).unwrap();
    let pending = runtime.begin("lease:runner-1").unwrap();
    let mut forged = binding.clone();
    forged.owner_id = "other-runner".to_string();
    let mut sink = TaskStoreReceiptSink {
        store: &store,
        binding: forged,
        clock: test_clock,
    };
    assert!(matches!(
        pending.persist(&mut sink),
        Err(TaskExecutionStoreAdapterError::Store(
            TaskStoreError::LeaseMismatch
        ))
    ));
    assert_eq!(
        runtime.phase(),
        crate::task_provider_fallback::ExecutionPhaseKind::Ready
    );
    assert_eq!(
        store
            .list_receipts(&binding.plan().identity().task_id, 16)
            .unwrap()
            .len(),
        receipt_count_before
    );
}

#[test]
fn durable_route_selection_precedes_the_preflight_action() {
    let (_directory, store, binding) = claimed_binding();
    let task_id = binding.plan().identity().task_id.clone();
    let mut runtime =
        crate::task_execution_runtime::TaskExecutionRuntime::new(binding.plan().clone()).unwrap();
    let mut sink = TaskStoreReceiptSink::new(&store, binding, test_clock).unwrap();
    let action = runtime
        .begin("lease:runner-1")
        .unwrap()
        .persist(&mut sink)
        .unwrap()
        .into_action();
    assert!(matches!(
        action,
        crate::task_execution_runtime::PersistedTaskExecutionAction::RunPreflight(_)
    ));
    let receipt = store.list_receipts(&task_id, 16).unwrap().pop().unwrap();
    let decision = receipt
        .execution
        .and_then(|execution| execution.provider_decision)
        .expect("route selection must be durable before preflight");
    assert_eq!(decision.stage, TaskProviderDecisionStage::RouteSelected);
    assert_eq!(decision.verdict, TaskProviderDecisionVerdict::Selected);
    assert_eq!(decision.catalogue_snapshot_id, snapshot_id('b'));
    assert_eq!(decision.catalogue_generated_at_ms, NOW - 1_000);
    assert_eq!(
        decision.catalogue_fresh_until_ms,
        NOW - 1_000 + TASK_PROVIDER_CATALOG_TTL_MS
    );
}

#[test]
fn catalogue_projection_rejects_unverified_model_and_unsupported_options() {
    let mut verified_model_draft = draft();
    verified_model_draft.candidates[0].model = TaskModelSelection::VerifiedModel {
        model_id: "guessed-model".to_string(),
    };
    let (_directory, _store, binding) = claimed_binding_with(verified_model_draft);
    assert!(matches!(
        binding.catalogue_entry(&catalogue(), 1, NOW),
        Err(TaskExecutionStoreAdapterError::UnsupportedVerifiedModel(_))
    ));
    let mut option_draft = draft();
    option_draft.candidates[0]
        .option_refs
        .push(crate::task_model::TaskProviderOptionReference {
            option_id: "unsupported".to_string(),
            reference_id: "opaque".to_string(),
        });
    let (_directory, _store, binding) = claimed_binding_with(option_draft);
    assert!(matches!(
        binding.catalogue_entry(&catalogue(), 1, NOW),
        Err(TaskExecutionStoreAdapterError::UnsupportedProviderOptions(
            _
        ))
    ));
}

#[test]
fn decision_mapping_covers_every_pre_effect_fallback_and_terminal_reason() {
    let (_directory, _store, binding) = claimed_binding();
    let pre_effect = [
        PreEffectRejectionReason::ProviderMissing,
        PreEffectRejectionReason::ProviderUnavailable,
        PreEffectRejectionReason::AuthenticationRequired,
        PreEffectRejectionReason::IncompatibleCapability,
        PreEffectRejectionReason::TargetOfflineBeforeDispatch,
        PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted,
        PreEffectRejectionReason::StructuredUnavailableNoTaskStarted,
    ];
    for reason in pre_effect {
        let mapped = store_decision(
            &decision(ProviderRouteDecisionReason::PreEffectRejected(reason)),
            &binding,
        );
        assert_eq!(mapped.stage, TaskProviderDecisionStage::Preflight);
        assert_eq!(
            mapped.verdict,
            TaskProviderDecisionVerdict::RejectedPreEffect
        );
        assert!(mapped.reason_code.is_some());
    }

    let terminal = [
        ProviderRouteDecisionReason::PreflightInconclusive,
        ProviderRouteDecisionReason::AmbiguousDispatch(
            AmbiguousDispatchReason::TransportLostAfterPromptDispatch,
        ),
        ProviderRouteDecisionReason::AmbiguousDispatch(
            AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch,
        ),
        ProviderRouteDecisionReason::Succeeded,
        ProviderRouteDecisionReason::Failed,
        ProviderRouteDecisionReason::Cancelled,
        ProviderRouteDecisionReason::TimedOut,
        ProviderRouteDecisionReason::OutcomeUnknown,
    ];
    for reason in terminal {
        let mapped = store_decision(&decision(reason), &binding);
        assert_eq!(mapped.stage, TaskProviderDecisionStage::Terminal);
        assert!(matches!(
            mapped.verdict,
            TaskProviderDecisionVerdict::Succeeded
                | TaskProviderDecisionVerdict::Failed
                | TaskProviderDecisionVerdict::OutcomeUnknown
        ));
        assert!(mapped.reason_code.is_some());
    }
    let unclassified = store_decision(
        &decision(ProviderRouteDecisionReason::AmbiguousDispatch(
            AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch,
        )),
        &binding,
    );
    assert_eq!(
        unclassified.verdict,
        TaskProviderDecisionVerdict::OutcomeUnknown
    );
}

#[test]
fn provider_session_evidence_keeps_only_bounded_session_identity() {
    let (_directory, _store, binding) = claimed_binding();
    let mut route = decision(ProviderRouteDecisionReason::Succeeded);
    route.evidence = DecisionEvidence::new(
        EvidenceClass::ProviderSession,
        "provider-session:run-77:event:event-5",
    );
    assert_eq!(
        store_decision(&route, &binding).session_id.as_deref(),
        Some("run-77")
    );
}
