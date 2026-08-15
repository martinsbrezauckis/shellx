use super::{
    task_runtime_tab_id, TaskGrokAcpEventBuffer, TaskProviderDispatchBinding,
    TaskProviderDispatchBindingError, TaskProviderEventBuffer, TaskProviderLifecycleEvent,
    TaskProviderResolvedTarget, TaskProviderRuntimePolicy, TASK_RUNTIME_TAB_PREFIX,
};
use crate::acp::SshRemoteRuntime;
use crate::provider_adapters::{
    ProviderCodexDriver, ProviderExecutionTransport, ProviderId, ProviderPermissionMode,
    ProviderShellxToolExposure,
};
use crate::provider_sessions::{
    ProviderSessionEvent, ProviderSessionEventKind, ProviderSessionRunTarget,
};
use crate::task_execution_bindings::TaskResolvedExecutionBindings;
use crate::task_execution_runtime::{
    TaskExecutionIdentity, TaskExecutionPlan, TaskExecutionTarget,
};
use crate::task_model::{
    TaskConcurrencyPolicy, TaskDefinitionRevision, TaskDraft, TaskEnvironmentSnapshot,
    TaskExecutionCandidate, TaskExecutionPolicy, TaskMissedRunPolicy, TaskNotificationPolicy,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_provider_fallback::{ModelSelection, TaskExecutionCandidate as RuntimeCandidate};

fn identity() -> TaskExecutionIdentity {
    TaskExecutionIdentity {
        task_id: "task-1".to_string(),
        revision_id: "revision-1".to_string(),
        revision_sha256: "a".repeat(64),
        occurrence_id: "occurrence-1".to_string(),
        attempt_id: "attempt-1".to_string(),
    }
}

fn plan(provider_id: &str) -> TaskExecutionPlan {
    TaskExecutionPlan::new(
        identity(),
        TaskExecutionTarget::new(
            format!("sha256:{}", "b".repeat(64)),
            "ssh:windows_wsl:host.test:22:wsl=ubuntu",
            "ssh",
            "windows_wsl",
        )
        .expect("target"),
        vec![RuntimeCandidate {
            provider_id: provider_id.to_string(),
            model: ModelSelection::ProviderDefault,
            order: 1,
        }],
    )
    .expect("plan")
}

fn revision(provider_id: &str) -> TaskDefinitionRevision {
    TaskDefinitionRevision {
        revision_id: "revision-1".to_string(),
        task_id: "task-1".to_string(),
        revision_number: 1,
        canonical_sha256: "a".repeat(64),
        created_at_ms: 1,
        draft: TaskDraft {
            name: "Task".to_string(),
            instruction: "Check the report.".to_string(),
            success_criteria: None,
            no_change_criteria: None,
            environment: TaskEnvironmentSnapshot {
                connection_id: "conn-1".to_string(),
                snapshot_id: format!("sha256:{}", "c".repeat(64)),
                target_key: "ssh:windows_wsl:host.test:22:wsl=ubuntu".to_string(),
                canonical_cwd: "/workspace".to_string(),
                project_id: Some("project-1".to_string()),
            },
            candidates: vec![TaskExecutionCandidate {
                order: 1,
                provider_id: provider_id.to_string(),
                model: crate::task_model::TaskModelSelection::ProviderDefault,
                capability_requirements: Vec::new(),
                option_refs: Vec::new(),
            }],
            execution_policy: TaskExecutionPolicy {
                permission_mode: "bypassPermissions".to_string(),
                autonomy_mode: "fullAuto".to_string(),
                tool_exposure_ids: Vec::new(),
            },
            attachment_refs: Vec::new(),
            workflow: None,
            vault_requirements: Vec::new(),
            trigger: TaskTrigger::Once { at_ms: 2_000 },
            timezone: "UTC".to_string(),
            missed_run_policy: TaskMissedRunPolicy::Skip,
            concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
            timeout_policy: TaskTimeoutPolicy {
                max_run_seconds: 60,
            },
            retry_policy: TaskRetryPolicy {
                max_attempts: 1,
                idempotent_observation_only: false,
            },
            notification_policy: TaskNotificationPolicy::AttentionOnly,
            retention_policy: TaskRetentionPolicy { max_receipts: 8 },
            origin: None,
        },
    }
}

fn target() -> TaskProviderResolvedTarget {
    TaskProviderResolvedTarget::new(
        "conn-1".to_string(),
        "ssh:windows_wsl:host.test:22:wsl=ubuntu".to_string(),
        "ssh".to_string(),
        "windows_wsl".to_string(),
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("host.test".to_string()),
            Some(22),
        )
        .with_ssh_runtime(SshRemoteRuntime::WindowsWsl, Some("ubuntu".to_string())),
    )
    .expect("target")
}

fn policy() -> TaskProviderRuntimePolicy {
    TaskProviderRuntimePolicy {
        permission_mode: ProviderPermissionMode::BypassPermissions,
        shellx_tool_exposure: ProviderShellxToolExposure::NativeFirst,
        codex_driver: ProviderCodexDriver::ExecJson,
    }
}

#[test]
fn immutable_binding_builds_fresh_external_session_request() {
    let plan = plan("codex-cli");
    let binding = TaskProviderDispatchBinding::from_immutable_revision(
        &plan,
        &revision("codex-cli"),
        target(),
        policy(),
        TaskResolvedExecutionBindings::default(),
    )
    .expect("binding");
    let request = binding
        .external_start_request_for_candidate(&plan.candidates()[0])
        .expect("request");

    assert_eq!(request.provider_id, ProviderId::CodexCli);
    assert_eq!(request.tab_id.as_deref(), Some(binding.task_tab_id()));
    assert_eq!(request.prompt, "Check the report.");
    assert_eq!(request.cwd, "/workspace");
    assert_eq!(request.transport, Some(ProviderExecutionTransport::Ssh));
    assert_eq!(request.ssh_remote_runtime, SshRemoteRuntime::WindowsWsl);
    assert_eq!(request.ssh_wsl_distro.as_deref(), Some("ubuntu"));
    assert_eq!(request.resume, Some(false));
    assert_eq!(request.timeout_ms, Some(60_000));
    assert!(request.release_fixture.is_none());
}

#[test]
fn immutable_binding_preserves_long_multiline_task_instructions() {
    let plan = plan("claude-code");
    let mut revision = revision("claude-code");
    let instruction = format!(
        "Review every item:\n\t{}\nReturn a concise result.",
        "x".repeat(2_048)
    );
    revision.draft.instruction = instruction.clone();
    revision.draft.environment.canonical_cwd = format!("/workspace/{}", "nested/".repeat(90));

    let binding = TaskProviderDispatchBinding::from_immutable_revision(
        &plan,
        &revision,
        target(),
        policy(),
        TaskResolvedExecutionBindings::default(),
    )
    .expect("long reviewed instruction remains dispatchable");
    let request = binding
        .external_start_request_for_candidate(&plan.candidates()[0])
        .expect("request");

    assert_eq!(request.prompt, instruction);
    assert_eq!(request.cwd, revision.draft.environment.canonical_cwd);
}

#[test]
fn immutable_binding_refuses_oversize_or_binary_task_instructions() {
    let plan = plan("codex-cli");
    let mut oversize = revision("codex-cli");
    oversize.draft.instruction = "x".repeat(24_001);
    assert!(matches!(
        TaskProviderDispatchBinding::from_immutable_revision(
            &plan,
            &oversize,
            target(),
            policy(),
            TaskResolvedExecutionBindings::default(),
        ),
        Err(TaskProviderDispatchBindingError::InvalidImmutableRevision)
    ));

    let mut binary = revision("codex-cli");
    binary.draft.instruction = "review\0hidden".to_string();
    assert!(matches!(
        TaskProviderDispatchBinding::from_immutable_revision(
            &plan,
            &binary,
            target(),
            policy(),
            TaskResolvedExecutionBindings::default(),
        ),
        Err(TaskProviderDispatchBindingError::InvalidImmutableRevision)
    ));
}

#[test]
fn binding_refuses_mutated_plan_or_connection_target() {
    let plan = plan("claude-code");
    let mismatched = TaskProviderResolvedTarget::new(
        "conn-2".to_string(),
        "ssh:windows_wsl:host.test:22:wsl=ubuntu".to_string(),
        "ssh".to_string(),
        "windows_wsl".to_string(),
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("host.test".to_string()),
            Some(22),
        )
        .with_ssh_runtime(SshRemoteRuntime::WindowsWsl, Some("ubuntu".to_string())),
    )
    .expect("shape is valid");
    let result = TaskProviderDispatchBinding::from_immutable_revision(
        &plan,
        &revision("claude-code"),
        mismatched,
        policy(),
        TaskResolvedExecutionBindings::default(),
    );
    assert!(matches!(
        result,
        Err(TaskProviderDispatchBindingError::ResolvedTargetMismatch)
    ));
}

#[test]
fn lifecycle_projection_never_retains_provider_text_or_diagnostics() {
    let event = ProviderSessionEvent {
        schema_version: 1,
        event_id: "event-1".to_string(),
        sequence: 4,
        occurred_at_ms: 99,
        run_id: "run-1".to_string(),
        tab_id: "task-run-test".to_string(),
        provider_id: ProviderId::ClaudeCode,
        kind: ProviderSessionEventKind::TextDelta,
        status: None,
        turn_id: Some("turn".to_string()),
        item_id: Some("item".to_string()),
        parent_item_id: None,
        tool_call_id: None,
        tool_name: None,
        tool_arguments: None,
        tool_result: None,
        subagent_id: None,
        parent_subagent_id: None,
        model: Some("model".to_string()),
        protocol: Some("stream".to_string()),
        protocol_version: None,
        binary_version: None,
        capabilities: vec!["tool".to_string()],
        target: None,
        text: Some("provider output must not enter Task receipts".to_string()),
        raw_type: Some("delta".to_string()),
        exit_code: None,
        error: Some("provider diagnostics".to_string()),
        provider_conversation_id: Some("conversation".to_string()),
        input_tokens: Some(3),
        output_tokens: Some(4),
        total_tokens: Some(7),
        usage: None,
        artifacts: Vec::new(),
        raw_reference: None,
    };
    let projected = TaskProviderLifecycleEvent::from_provider_event(&event).expect("project");
    let runtime = projected.into_runtime_event();

    assert_eq!(runtime.text.as_deref(), Some("activity"));
    assert!(runtime.error.is_none());
    assert!(runtime.tool_arguments.is_none());
    assert!(runtime.tool_result.is_none());
    assert!(runtime.provider_conversation_id.is_none());
    assert!(runtime.capabilities.is_empty());

    let buffer = TaskProviderEventBuffer::new("task-run-test".to_string(), ProviderId::ClaudeCode);
    buffer.observe_provider_event(&event);
    buffer.bind_run("different-run");
    assert!(buffer.drain().is_empty());
}

#[test]
fn task_runtime_tab_id_is_stable_and_attempt_scoped() {
    let first = identity();
    let mut second = identity();
    second.attempt_id = "attempt-2".to_string();
    let mut prefixed = first.clone();
    prefixed.revision_sha256 = format!("sha256:{}", prefixed.revision_sha256);

    assert_eq!(task_runtime_tab_id(&first), task_runtime_tab_id(&first));
    assert_eq!(task_runtime_tab_id(&first), task_runtime_tab_id(&prefixed));
    assert_ne!(task_runtime_tab_id(&first), task_runtime_tab_id(&second));
    assert!(task_runtime_tab_id(&first).starts_with(TASK_RUNTIME_TAB_PREFIX));
}

#[test]
fn grok_event_projection_keeps_only_lifecycle_shape() {
    let buffer = TaskGrokAcpEventBuffer::new("task-run-test".to_string()).expect("buffer");
    buffer.observe_payload(
        "task-run-test",
        &serde_json::json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "secret provider output" },
                    "untrusted": { "large": "raw event is discarded" }
                }
            }
        }),
    );
    buffer.observe_payload(
        "task-run-test",
        &serde_json::json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "contentPresent": true
                }
            }
        }),
    );
    buffer.observe_payload(
        "task-run-test",
        &serde_json::json!({
            "method": "session/request_permission",
            "params": {
                "requestId": 17,
                "permissionMode": "bypassPermissions",
                "lifecycle": "auto_approved"
            }
        }),
    );
    buffer.observe_payload(
        "different-tab",
        &serde_json::json!({
            "method": "_x.ai/session/prompt_complete",
            "params": { "stopReason": "completed" }
        }),
    );

    let events = buffer.drain();
    assert_eq!(events.len(), 3);
    let projected = events
        .into_iter()
        .map(|event| event.into_runtime_payload("task-run-test"))
        .collect::<Vec<_>>();
    assert_eq!(projected[0].0["method"], "session/update");
    assert_eq!(
        projected[0].0["params"]["update"]["content"]["text"],
        "activity"
    );
    assert_eq!(projected[1].0["method"], "session/update");
    assert_eq!(
        projected[1].0["params"]["update"]["content"]["text"],
        "activity"
    );
    assert_eq!(
        projected[2].0["params"]["update"]["sessionUpdate"],
        "tool_call_update"
    );
    assert!(projected
        .iter()
        .all(|(payload, _)| !payload.to_string().contains("secret provider output")));
    assert_eq!(projected[0].1, "task-grok-acp:task-run-test:event:1");
}
