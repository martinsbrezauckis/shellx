use super::*;

fn draft() -> TaskDraft {
    TaskDraft {
        name: "Daily report".to_string(),
        instruction: "Summarize the project status.".to_string(),
        success_criteria: None,
        no_change_criteria: None,
        environment: TaskEnvironmentSnapshot {
            connection_id: "local".to_string(),
            snapshot_id: format!("sha256:{}", "a".repeat(64)),
            target_key: "local:linux".to_string(),
            canonical_cwd: "/workspace".to_string(),
            project_id: Some("shellx".to_string()),
        },
        candidates: vec![TaskExecutionCandidate {
            order: 1,
            provider_id: "codex-cli".to_string(),
            model: TaskModelSelection::ProviderDefault,
            capability_requirements: vec!["filesystemRead".to_string()],
            option_refs: Vec::new(),
        }],
        execution_policy: TaskExecutionPolicy {
            permission_mode: "default".to_string(),
            autonomy_mode: "default".to_string(),
            tool_exposure_ids: vec!["nativeFirst".to_string()],
        },
        attachment_refs: Vec::new(),
        workflow: None,
        vault_requirements: vec![TaskVaultRequirement {
            key_id: "reports-api".to_string(),
            grant_id: Some("task-grant".to_string()),
        }],
        trigger: TaskTrigger::Weekdays {
            at: TaskLocalTime {
                hour: 9,
                minute: 30,
            },
        },
        timezone: "Europe/Riga".to_string(),
        missed_run_policy: TaskMissedRunPolicy::Skip,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 600,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts: 8 },
        origin: Some(TaskOrigin {
            session_id: Some("session-1".to_string()),
            tab_id: Some("tab-1".to_string()),
        }),
    }
}

#[test]
fn canonical_revision_hash_is_stable_after_normalization() {
    let clean = normalize_and_validate_draft(draft()).unwrap();
    let mut whitespace = draft();
    whitespace.name = "  Daily report  ".to_string();
    whitespace.instruction = "  Summarize the project status.  ".to_string();
    let normalized = normalize_and_validate_draft(whitespace).unwrap();
    assert_eq!(
        canonical_revision_hash("task-1", 1, &clean).unwrap(),
        canonical_revision_hash("task-1", 1, &normalized).unwrap()
    );
}

#[test]
fn candidate_routes_must_be_non_empty_contiguous_and_unique() {
    let mut invalid = draft();
    invalid.candidates.clear();
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    invalid.candidates[0].order = 2;
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    let duplicate = invalid.candidates[0].clone();
    invalid.candidates.push(TaskExecutionCandidate {
        order: 2,
        ..duplicate
    });
    assert!(normalize_and_validate_draft(invalid).is_err());
}

#[test]
fn trigger_contract_rejects_impossible_clock_values() {
    let mut invalid = draft();
    invalid.trigger = TaskTrigger::Monthly {
        day: 32,
        at: TaskLocalTime {
            hour: 24,
            minute: 0,
        },
    };
    assert!(normalize_and_validate_draft(invalid).is_err());
}

#[test]
fn once_trigger_uses_the_renderer_camel_case_wire_contract() {
    let trigger: TaskTrigger = serde_json::from_value(
        serde_json::json!({ "kind": "once", "atMs": 1_786_733_820_000_i64 }),
    )
    .unwrap();
    assert_eq!(
        trigger,
        TaskTrigger::Once {
            at_ms: 1_786_733_820_000,
        }
    );
    assert_eq!(
        serde_json::to_value(trigger).unwrap(),
        serde_json::json!({ "kind": "once", "atMs": 1_786_733_820_000_i64 })
    );
}

#[test]
fn environment_requires_an_exact_scan_digest_and_supported_provider_id() {
    let mut invalid = draft();
    invalid.environment.snapshot_id = "sha256:ABC".to_string();
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    invalid.candidates[0].provider_id = "guessed-provider".to_string();
    assert!(normalize_and_validate_draft(invalid).is_err());
}

#[test]
fn execution_policy_refuses_unrunnable_permission_and_tool_shapes() {
    for (permission_mode, autonomy_mode) in [
        ("default", "bypassPermissions"),
        ("bypassPermissions", "default"),
        ("ask", "supervised"),
    ] {
        let mut invalid = draft();
        invalid.execution_policy.permission_mode = permission_mode.to_string();
        invalid.execution_policy.autonomy_mode = autonomy_mode.to_string();
        assert!(normalize_and_validate_draft(invalid).is_err());
    }

    for exposure in [vec![], vec!["filesystem"], vec!["off", "nativeFirst"]] {
        let mut invalid = draft();
        invalid.execution_policy.tool_exposure_ids =
            exposure.into_iter().map(str::to_string).collect();
        assert!(normalize_and_validate_draft(invalid).is_err());
    }

    for (permission_mode, autonomy_mode) in [
        ("default", "plan"),
        ("default", "acceptEdits"),
        ("default", "default"),
        ("bypassPermissions", "bypassPermissions"),
    ] {
        let mut valid = draft();
        valid.execution_policy.permission_mode = permission_mode.to_string();
        valid.execution_policy.autonomy_mode = autonomy_mode.to_string();
        assert!(normalize_and_validate_draft(valid).is_ok());
    }
}

#[test]
fn durable_content_references_require_canonical_sha256_digests() {
    let mut with_references = draft();
    with_references.attachment_refs = vec![TaskAttachmentReference {
        attachment_id: "attachment-1".to_string(),
        digest: Some(format!("sha256:{}", "B".repeat(64))),
    }];
    with_references.workflow = Some(TaskWorkflowReference {
        workflow_id: "workflow-1".to_string(),
        digest: "A".repeat(64),
    });
    let normalized = normalize_and_validate_draft(with_references).unwrap();
    let expected_attachment = format!("sha256:{}", "b".repeat(64));
    let expected_workflow = format!("sha256:{}", "a".repeat(64));
    assert_eq!(
        normalized.attachment_refs[0].digest.as_deref(),
        Some(expected_attachment.as_str())
    );
    assert_eq!(
        normalized
            .workflow
            .as_ref()
            .map(|workflow| workflow.digest.as_str()),
        Some(expected_workflow.as_str())
    );

    let mut malformed_workflow = draft();
    malformed_workflow.workflow = Some(TaskWorkflowReference {
        workflow_id: "workflow-1".to_string(),
        digest: "not-a-digest".to_string(),
    });
    assert!(normalize_and_validate_draft(malformed_workflow).is_err());

    let mut malformed_attachment = draft();
    malformed_attachment.attachment_refs = vec![TaskAttachmentReference {
        attachment_id: "attachment-1".to_string(),
        digest: Some("sha256:1234".to_string()),
    }];
    assert!(normalize_and_validate_draft(malformed_attachment).is_err());
}

#[test]
fn scheduler_policy_is_bounded_and_uses_a_real_iana_timezone() {
    let mut invalid = draft();
    invalid.timezone = "Europe/Not-A-Real-City".to_string();
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    invalid.concurrency_policy.max_active_runs = 2;
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    invalid.timeout_policy.max_run_seconds = 29;
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut invalid = draft();
    invalid.retry_policy.max_attempts = 2;
    invalid.retry_policy.idempotent_observation_only = false;
    assert!(normalize_and_validate_draft(invalid).is_err());

    let mut valid = draft();
    valid.retry_policy.max_attempts = 2;
    valid.retry_policy.idempotent_observation_only = true;
    assert!(normalize_and_validate_draft(valid).is_ok());
}
