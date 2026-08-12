//! Focused deterministic Teach source-contract tests.

use serde_json::{json, Value};

use super::*;
use crate::shellx_browser::{BrowserFlightRecorderExportRequest, StartBrowserTaskRequest};

fn complete_attempt(
    with_redacted_input: bool,
    with_press: bool,
) -> (ShellxBrowserRegistry, String, String) {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Submit the example form".to_string(),
                start_url: None,
                ..StartBrowserTaskRequest::default()
            },
            Some("teach-owner"),
        )
        .expect("agent task starts");
    let browser_tab_id = {
        let state = lock_or_recover(&registry.state);
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .map(|tab| tab.browser_tab_id.clone())
            .expect("task has Browser tab")
    };
    {
        let mut state = lock_or_recover(&registry.state);
        push_receipt(
            &mut state,
            "browserNavigated",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Navigation completed".to_string(),
            json!({
                "browserTabId": browser_tab_id.clone(),
                "url": "https://example.com/form?private=query#fragment",
            }),
        );
        push_receipt(
            &mut state,
            "browserEngineActionApplied",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Click completed".to_string(),
            json!({
                "browserTabId": browser_tab_id.clone(),
            "action": if with_press { "press" } else if with_redacted_input { "fillRef" } else { "clickRef" },
            "refId": if with_redacted_input { "form-email" } else { "form-submit" },
            "selector": if with_redacted_input { "#email" } else { "#submit" },
                "value": if with_redacted_input { json!("operator@example.test") } else { Value::Null },
            "key": if with_press { "Enter" } else { "" },
            }),
        );
    }
    registry
        .finish_task_for_agent_session(
            Some(task.task_id.clone()),
            Some("completed".to_string()),
            None,
            Some("teach-owner"),
        )
        .expect("task finishes");
    let artifact = registry
        .export_flight_recorder_for_agent_session(
            BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(browser_tab_id),
                ..BrowserFlightRecorderExportRequest::default()
            },
            Some("teach-owner"),
        )
        .expect("Flight Recorder artifact exports");
    (registry, task.task_id, artifact.attempt_id)
}

fn cleanup_teach_artifacts(registry: &ShellxBrowserRegistry) {
    let state = lock_or_recover(&registry.state);
    for draft in state.teach_drafts.values() {
        let _ = std::fs::remove_file(&draft._bundle_path);
        for path in draft.revision_paths.values() {
            let _ = std::fs::remove_file(path);
        }
    }
    for receipt in &state.receipts {
        if matches!(
            receipt.kind.as_str(),
            "browserFlightRecorderExported" | "browserRecipeExported"
        ) {
            if let Some(path) = receipt.evidence.get("path").and_then(Value::as_str) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[test]
fn teach_prepare_is_deterministic_cas_bound_and_approval_only_creates_recipe() {
    let (registry, task_id, attempt_id) = complete_attempt(false, false);
    let prepared = registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest {
                attempt_id: attempt_id.clone(),
            },
            Some("teach-owner"),
        )
        .expect("Teach prepares complete owned evidence");
    assert_eq!(
        prepared.bundle.schema_version,
        "sx.workflow-teach-bundle.v1"
    );
    assert_eq!(
        prepared.revision.schema_version,
        "sx.workflow-teach-revision.v1"
    );
    assert_eq!(prepared.bundle.source.task_id, task_id);
    assert!(!serde_json::to_string(&prepared)
        .unwrap()
        .contains("browser-artifacts"));
    let repeated = registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest { attempt_id },
            Some("teach-owner"),
        )
        .expect("same attempt is idempotent");
    assert_eq!(repeated.draft.draft_id, prepared.draft.draft_id);
    assert_eq!(repeated.bundle.sha256, prepared.bundle.sha256);
    let navigation_value_id = prepared
        .revision
        .steps
        .iter()
        .find(|step| step.operation == "navigate")
        .and_then(|step| step.value_refs.first())
        .cloned()
        .expect("redacted navigation has an editable named URL value");
    assert!(prepared.revision.values.iter().any(|value| {
        value.value_id == navigation_value_id && value.label.starts_with("Navigation URL")
    }));
    let redacted_navigation_issue = prepared
        .bundle
        .ambiguities
        .iter()
        .find(|issue| issue.code == "redactedNavigationPath" && issue.blocking)
        .map(|issue| issue.issue_id.clone())
        .expect("redacted path is an explicit blocking ambiguity");

    let revised = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: prepared.revision.revision_id.clone(),
                expected_revision_sha256: prepared.revision.sha256.clone(),
                goal: Some("Submit the safe example form".to_string()),
                ordered_step_ids: None,
                value_edits: None,
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: None,
                revision_note: Some("Operator clarified goal".to_string()),
            },
            Some("teach-owner"),
        )
        .expect("CAS revision writes");
    assert_eq!(revised.revision.revision, 2);
    assert!(registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: prepared.revision.revision_id,
                expected_revision_sha256: prepared.revision.sha256,
                goal: None,
                ordered_step_ids: None,
                value_edits: None,
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: None,
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect_err("stale revision must not write")
        .contains("compare-and-swap"));
    assert!(registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id.clone(),
            revision_id: revised.revision.revision_id.clone(),
            revision_sha256: revised.revision.sha256.clone(),
        })
        .expect_err("a redacted navigation placeholder cannot be approved")
        .contains("redacted navigation"));
    let resolved_without_replacement = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: revised.revision.revision_id.clone(),
                expected_revision_sha256: revised.revision.sha256.clone(),
                goal: None,
                ordered_step_ids: None,
                value_edits: None,
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: Some(vec![redacted_navigation_issue.clone()]),
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect("an issue resolution alone remains an immutable CAS revision");
    assert!(registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id.clone(),
            revision_id: resolved_without_replacement.revision.revision_id.clone(),
            revision_sha256: resolved_without_replacement.revision.sha256.clone(),
        })
        .expect_err("resolution cannot approve the placeholder itself")
        .contains("safe HTTP(S) URL"));
    let corrected = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: resolved_without_replacement.revision.revision_id,
                expected_revision_sha256: resolved_without_replacement.revision.sha256,
                goal: None,
                ordered_step_ids: None,
                value_edits: Some(vec![BrowserTeachValueEdit {
                    value_id: navigation_value_id,
                    label: None,
                    literal: Some("https://example.com/safe-form".to_string()),
                }]),
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: Some(vec![redacted_navigation_issue]),
                revision_note: Some("Operator supplied a safe navigation URL".to_string()),
            },
            Some("teach-owner"),
        )
        .expect("safe URL replacement and explicit resolution write a CAS revision");
    let approval = registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id,
            revision_id: corrected.revision.revision_id,
            revision_sha256: corrected.revision.sha256,
        })
        .expect("operator approval writes a normal recipe after URL replacement");
    assert_eq!(approval.approval.status, "recipeDraftCreated");
    assert_eq!(approval.recipe.source, "shellx-browser-recorder");
    assert_eq!(approval.recipe.teach_source, "shellx-browser-teach");
    let rehearsal = registry
        .rehearse_teach_recipe_from_operator(BrowserTeachRehearseRequest {
            recipe_id: approval.recipe.recipe_id.clone(),
            sha256: approval.recipe.sha256.clone(),
        })
        .expect("operator rehearsal uses the receipt-bound dry-run planner");
    assert!(rehearsal.dry_run);
    assert_eq!(rehearsal.steps_applied, 0);
    assert!(rehearsal.steps_planned > 0);
    assert_eq!(rehearsal.receipt.kind, "browserTeachRecipeRehearsed");
    assert!(!serde_json::to_string(&rehearsal)
        .expect("compact rehearsal encodes")
        .contains("browser-artifacts"));
    let state = lock_or_recover(&registry.state);
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserRecipeExported"
            && receipt.evidence.get("recipeId").and_then(Value::as_str)
                == Some(approval.recipe.recipe_id.as_str())
    }));
    let recipe_path = state
        .receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.kind == "browserRecipeExported"
                && receipt.evidence.get("recipeId").and_then(Value::as_str)
                    == Some(approval.recipe.recipe_id.as_str())
        })
        .and_then(|receipt| receipt.evidence.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .expect("recipe receipt retains its internal replay identity");
    assert!(!state
        .receipts
        .iter()
        .any(|receipt| receipt.kind.contains("RecipeApplied")));
    drop(state);
    let dry_run_plan = registry
        .browser_recipe_replay_plan(&crate::shellx_browser::BrowserRecipeReplayRequest {
            task_id: Some(task_id),
            recipe_path: Some(recipe_path),
            dry_run: Some(true),
            ..crate::shellx_browser::BrowserRecipeReplayRequest::default()
        })
        .expect("approved recipe remains compatible with existing dry-run planning");
    assert!(dry_run_plan.steps_planned > 0);
    cleanup_teach_artifacts(&registry);
}

#[test]
fn teach_rejects_cross_owner_and_requires_vault_binding_for_redacted_input() {
    let (registry, _, attempt_id) = complete_attempt(true, false);
    assert!(registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest {
                attempt_id: attempt_id.clone()
            },
            Some("another-owner"),
        )
        .expect_err("cross-owner attempt is denied")
        .contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    let prepared = registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest { attempt_id },
            Some("teach-owner"),
        )
        .expect("owner prepares draft");
    let navigation_value_id = prepared
        .revision
        .steps
        .iter()
        .find(|step| step.operation == "navigate")
        .and_then(|step| step.value_refs.first())
        .cloned()
        .expect("redacted navigation has an editable URL value");
    let redacted_navigation_issue = prepared
        .bundle
        .ambiguities
        .iter()
        .find(|issue| issue.code == "redactedNavigationPath")
        .map(|issue| issue.issue_id.clone())
        .expect("redacted navigation requires explicit resolution");
    let url_replaced = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: prepared.revision.revision_id.clone(),
                expected_revision_sha256: prepared.revision.sha256.clone(),
                goal: None,
                ordered_step_ids: None,
                value_edits: Some(vec![BrowserTeachValueEdit {
                    value_id: navigation_value_id,
                    label: None,
                    literal: Some("https://example.com/safe-form".to_string()),
                }]),
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: Some(vec![redacted_navigation_issue]),
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect("safe URL replacement writes");
    assert!(registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id.clone(),
            revision_id: url_replaced.revision.revision_id.clone(),
            revision_sha256: url_replaced.revision.sha256.clone(),
        })
        .expect_err("unbound redacted input is unsafe")
        .contains("Vault binding"));
    let bindings = prepared
        .revision
        .required_vault_bindings
        .iter()
        .map(|binding| BrowserTeachVaultBinding {
            value_id: binding.value_id.clone(),
            binding_id: Some("vault/binding-safe".to_string()),
        })
        .collect();
    let revised = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: url_replaced.revision.revision_id,
                expected_revision_sha256: url_replaced.revision.sha256,
                goal: None,
                ordered_step_ids: None,
                value_edits: None,
                vault_bindings: Some(bindings),
                required_capabilities: None,
                ambiguity_resolutions: None,
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect("binding revision writes");
    let approval = registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id,
            revision_id: revised.revision.revision_id,
            revision_sha256: revised.revision.sha256,
        })
        .expect("opaque Vault binding is retained without automatic injection");
    let state = lock_or_recover(&registry.state);
    let recipe_path = state
        .receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.kind == "browserRecipeExported"
                && receipt.evidence.get("recipeId").and_then(Value::as_str)
                    == Some(approval.recipe.recipe_id.as_str())
        })
        .and_then(|receipt| receipt.evidence.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .expect("approved recipe receipt retains private artifact identity");
    drop(state);
    let recipe: Value = serde_json::from_slice(
        &std::fs::read(recipe_path).expect("private recipe artifact remains readable in test"),
    )
    .expect("recipe artifact is JSON");
    assert!(recipe["variableInputs"]
        .as_array()
        .is_some_and(|inputs| inputs
            .iter()
            .any(|input| input.get("vaultBindingId").and_then(Value::as_str)
                == Some("vault/binding-safe"))));
    assert!(recipe["steps"]
        .as_array()
        .is_some_and(|steps| steps.iter().any(|step| {
            step.get("action").and_then(Value::as_str) == Some("fillRef")
                && step.get("vaultBindingId").and_then(Value::as_str) == Some("vault/binding-safe")
                && step.get("valueRedacted").and_then(Value::as_bool) == Some(true)
        })));
    cleanup_teach_artifacts(&registry);
}

#[test]
fn teach_navigation_value_edits_require_safe_http_urls() {
    let (registry, _, attempt_id) = complete_attempt(false, false);
    let prepared = registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest { attempt_id },
            Some("teach-owner"),
        )
        .expect("owner prepares draft");
    let navigation_value_id = prepared
        .revision
        .steps
        .iter()
        .find(|step| step.operation == "navigate")
        .and_then(|step| step.value_refs.first())
        .cloned()
        .expect("navigation value is present");
    for unsafe_url in [
        "https://user:pass@example.com/form",
        "https://example.com/form?private=query",
        "https://example.com/form#fragment",
        "file:///tmp/private-form",
        "https://example.com/[redacted-path]",
        "https://example.com/.shellx/private-form",
    ] {
        assert!(
            registry
                .revise_teach_draft_for_agent_session(
                    BrowserTeachRevisionRequest {
                        draft_id: prepared.draft.draft_id.clone(),
                        expected_revision_id: prepared.revision.revision_id.clone(),
                        expected_revision_sha256: prepared.revision.sha256.clone(),
                        goal: None,
                        ordered_step_ids: None,
                        value_edits: Some(vec![BrowserTeachValueEdit {
                            value_id: navigation_value_id.clone(),
                            label: None,
                            literal: Some(unsafe_url.to_string()),
                        }]),
                        vault_bindings: None,
                        required_capabilities: None,
                        ambiguity_resolutions: None,
                        revision_note: None,
                    },
                    Some("teach-owner"),
                )
                .is_err(),
            "{unsafe_url} must be rejected"
        );
    }
    let valid = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: prepared.revision.revision_id,
                expected_revision_sha256: prepared.revision.sha256,
                goal: None,
                ordered_step_ids: None,
                value_edits: Some(vec![BrowserTeachValueEdit {
                    value_id: navigation_value_id,
                    label: None,
                    literal: Some("http://localhost:3000/safe".to_string()),
                }]),
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: None,
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect("local HTTP(S) navigation URL without query or fragment is retained");
    assert!(valid
        .revision
        .values
        .iter()
        .any(|value| { value.literal.as_deref() == Some("http://localhost:3000/safe") }));
    cleanup_teach_artifacts(&registry);
}

#[test]
fn teach_press_with_a_bounded_key_needs_no_vault_binding() {
    let (registry, _, attempt_id) = complete_attempt(false, true);
    let prepared = registry
        .prepare_teach_draft_for_agent_session(
            BrowserTeachPrepareRequest { attempt_id },
            Some("teach-owner"),
        )
        .expect("owner prepares press evidence");
    let press = prepared
        .revision
        .steps
        .iter()
        .find(|step| step.operation == "press")
        .expect("press is projected as a replayable step");
    assert!(press.value_refs.is_empty());
    assert_eq!(
        press.recipe_step.get("key").and_then(Value::as_str),
        Some("Enter")
    );
    assert_eq!(
        press
            .recipe_step
            .get("valueRedacted")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert!(prepared.revision.required_vault_bindings.is_empty());
    let navigation_value_id = prepared
        .revision
        .steps
        .iter()
        .find(|step| step.operation == "navigate")
        .and_then(|step| step.value_refs.first())
        .cloned()
        .expect("navigation remains explicitly editable");
    let redacted_navigation_issue = prepared
        .bundle
        .ambiguities
        .iter()
        .find(|issue| issue.code == "redactedNavigationPath")
        .map(|issue| issue.issue_id.clone())
        .expect("navigation requires an explicit resolution");
    let revised = registry
        .revise_teach_draft_for_agent_session(
            BrowserTeachRevisionRequest {
                draft_id: prepared.draft.draft_id.clone(),
                expected_revision_id: prepared.revision.revision_id,
                expected_revision_sha256: prepared.revision.sha256,
                goal: None,
                ordered_step_ids: None,
                value_edits: Some(vec![BrowserTeachValueEdit {
                    value_id: navigation_value_id,
                    label: None,
                    literal: Some("https://example.com/press-form".to_string()),
                }]),
                vault_bindings: None,
                required_capabilities: None,
                ambiguity_resolutions: Some(vec![redacted_navigation_issue]),
                revision_note: None,
            },
            Some("teach-owner"),
        )
        .expect("safe URL replacement writes");
    assert!(registry
        .approve_teach_draft_from_operator(BrowserTeachApprovalRequest {
            draft_id: prepared.draft.draft_id,
            revision_id: revised.revision.revision_id,
            revision_sha256: revised.revision.sha256,
        })
        .is_ok());
    cleanup_teach_artifacts(&registry);
}

#[test]
fn teach_rehearsal_rejects_an_export_without_teach_approval() {
    let registry = ShellxBrowserRegistry::default();
    let sha256 = "a".repeat(64);
    {
        let mut state = lock_or_recover(&registry.state);
        push_receipt(
            &mut state,
            "browserRecipeExported",
            None,
            None,
            "Ordinary recipe export".to_string(),
            json!({
                "recipeId": "ordinary-recipe",
                "sha256": sha256,
                "source": "shellx-browser-recipes",
            }),
        );
    }
    assert!(registry
        .rehearse_teach_recipe_from_operator(BrowserTeachRehearseRequest {
            recipe_id: "ordinary-recipe".to_string(),
            sha256,
        })
        .expect_err("ordinary exports have no Teach approval receipt")
        .contains("Teach approval receipt"));
}

#[test]
fn teach_ignores_non_replayable_recorder_context() {
    let context_kinds = [
        "browserEngineMounted",
        "browserEngineNavigated",
        "browserEngineLoaded",
        "browserEngineObserved",
        "browserCdpAccessRequested",
        "browserCdpAccessApproved",
        "browserDeveloperModeChanged",
        "browserHarExported",
        "browserPerformanceExported",
    ];
    let mut receipts = vec![json!({
        "sourceSequence": 1,
        "receiptId": "receipt-navigation",
        "kind": "browserNavigated",
        "evidence": { "url": "https://example.com/form" },
    })];
    receipts.extend(context_kinds.iter().enumerate().map(|(index, kind)| {
        json!({
            "sourceSequence": index as u64 + 2,
            "receiptId": format!("receipt-context-{index}"),
            "kind": kind,
            "evidence": {},
        })
    }));
    let (steps, _, ambiguities, loss) =
        extract_teach_bundle("teach-bundle-context", &json!({ "receipts": receipts }))
            .expect("non-replayable recorder context is ignored safely");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].operation, "navigate");
    assert!(ambiguities
        .iter()
        .any(|issue| issue.code == "redactedNavigationPath"));
    assert!(loss.is_empty());
}
