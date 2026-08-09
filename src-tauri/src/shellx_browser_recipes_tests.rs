use super::*;

#[test]
fn recipe_path_reads_are_constrained_to_recipe_artifacts() {
    let root = crate::shellx_browser_artifacts::browser_artifact_root("shellx-browser-recipes")
        .expect("recipe root resolves");
    std::fs::create_dir_all(&root).expect("recipe root can be created for test");
    let outside = tempfile::NamedTempFile::new().expect("outside temp recipe");
    std::fs::write(outside.path(), r#"{"schemaVersion":2,"steps":[]}"#)
        .expect("outside temp recipe can be written");
    let request = BrowserRecipeReplayRequest {
        recipe_path: Some(outside.path().to_string_lossy().into_owned()),
        ..BrowserRecipeReplayRequest::default()
    };

    let error = browser_recipe_value_from_request(&request).expect_err("outside path rejected");

    assert!(
        error.contains("outside ShellX Browser recipe artifacts"),
        "{error}"
    );
}

#[test]
fn saved_recipe_replay_requires_exact_export_receipt_identity() {
    struct RemoveArtifact(std::path::PathBuf);
    impl Drop for RemoveArtifact {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    let registry = ShellxBrowserRegistry::default();
    let recipe_id = browser_id("browser-recipe-test");
    let recipe = json!({
        "schemaVersion": 2,
        "recipeId": recipe_id,
        "createdAtMs": now_ms(),
        "source": "shellx-browser-recorder",
        "taskId": serde_json::Value::Null,
        "steps": [{ "action": "navigate", "url": "https://example.com/" }]
    });
    let (path, bytes, sha256) = write_browser_json_artifact(
        "shellx-browser-recipes",
        "recipe-test",
        &recipe_id,
        now_ms(),
        &recipe,
    )
    .expect("test recipe writes");
    let _cleanup = RemoveArtifact(std::path::PathBuf::from(&path));
    let request = BrowserRecipeReplayRequest {
        recipe_path: Some(path.clone()),
        ..BrowserRecipeReplayRequest::default()
    };

    let missing_receipt = registry
        .browser_recipe_replay_plan(&request)
        .expect_err("unreceipted saved recipe must fail closed");
    assert!(missing_receipt.contains("no matching export receipt"));

    {
        let mut state = lock_or_recover(&registry.state);
        push_receipt(
            &mut state,
            "browserRecipeExported",
            None,
            None,
            "Test Browser recipe export".to_string(),
            json!({
                "recipeId": recipe_id,
                "path": path,
                "bytes": bytes,
                "sha256": sha256,
                "source": "shellx-browser-recipes",
            }),
        );
    }
    let plan = registry
        .browser_recipe_replay_plan(&request)
        .expect("matching receipt permits saved recipe replay");
    assert_eq!(plan.steps_planned, 1);

    let mut changed_recipe = recipe;
    changed_recipe["steps"][0]["url"] = json!("https://example.net/");
    std::fs::write(
        request.recipe_path.as_ref().expect("recipe path exists"),
        serde_json::to_vec_pretty(&changed_recipe).expect("changed recipe serializes"),
    )
    .expect("test recipe can be changed");
    let changed = registry
        .browser_recipe_replay_plan(&request)
        .expect_err("changed saved recipe must fail closed");
    assert!(
        changed.contains("does not match its export receipt")
            || changed.contains("changed while it was being read"),
        "{changed}"
    );
}

#[test]
fn recipe_replay_rejects_missing_empty_and_ambiguous_sources() {
    let missing = browser_recipe_replay_plan(&BrowserRecipeReplayRequest::default())
        .expect_err("missing recipe source must fail closed");
    assert!(
        missing.contains("requires recipe or recipePath"),
        "{missing}"
    );

    let empty = browser_recipe_replay_plan(&BrowserRecipeReplayRequest {
        recipe: Some(json!({ "schemaVersion": 2, "steps": [] })),
        ..BrowserRecipeReplayRequest::default()
    })
    .expect_err("empty recipe must not report a completed replay");
    assert!(empty.contains("at least one replayable step"), "{empty}");

    let ambiguous = browser_recipe_replay_plan(&BrowserRecipeReplayRequest {
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [{ "action": "navigate", "url": "https://example.com/" }]
        })),
        recipe_path: Some("/tmp/shellx-browser-recipes/recipe.json".to_string()),
        ..BrowserRecipeReplayRequest::default()
    })
    .expect_err("inline recipe must not masquerade as a saved artifact");
    assert!(ambiguous.contains("never both"), "{ambiguous}");
}

#[test]
fn recipe_replay_plan_converts_safe_steps_and_skips_redacted_inputs() {
    let request = BrowserRecipeReplayRequest {
        task_id: Some("browser-task-current".to_string()),
        browser_tab_id: Some("browser-tab-current".to_string()),
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [
                {
                    "action": "navigate",
                    "url": "https://example.com/",
                    "browserTabId": "browser-tab-old"
                },
                {
                    "action": "clickRef",
                    "refId": "settings",
                    "selector": "button[data-testid='settings']",
                    "force": true,
                    "browserTabId": "browser-tab-old"
                },
                {
                    "action": "waitFor",
                    "selector": "[data-testid='api-keys']",
                    "timeoutMs": 9000,
                    "browserTabId": "browser-tab-old"
                },
                {
                    "action": "fillRef",
                    "refId": "email",
                    "selector": "#email",
                    "browserTabId": "browser-tab-old",
                    "valueRedacted": true
                },
                {
                    "action": "select",
                    "selector": "#region",
                    "value": "eu",
                    "valueRedacted": false
                },
                {
                    "action": "press",
                    "selector": "#search",
                    "key": "Enter",
                    "valueRedacted": false
                },
                {
                    "action": "verify",
                    "key": "element",
                    "selector": "[data-testid='api-keys']"
                },
                {
                    "action": "capturePageSecretToVault",
                    "selector": "[data-testid='secret']"
                },
                {
                    "action": "findText",
                    "query": "Example Domain",
                    "queryRedacted": false
                }
            ]
        })),
        dry_run: Some(false),
        ..BrowserRecipeReplayRequest::default()
    };

    let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

    assert_eq!(plan.steps_planned, 9);
    assert_eq!(plan.actions.len(), 3);
    assert_eq!(plan.skipped_steps.len(), 6);
    assert_eq!(plan.actions[0].request.action, "navigate");
    assert_eq!(
        plan.actions[0].request.task_id.as_deref(),
        Some("browser-task-current")
    );
    assert_eq!(
        plan.actions[0].request.browser_tab_id.as_deref(),
        Some("browser-tab-current")
    );
    assert_eq!(
        plan.actions[0].request.url.as_deref(),
        Some("https://example.com/")
    );
    assert_eq!(plan.actions[1].request.action, "clickRef");
    assert_eq!(plan.actions[1].request.ref_id.as_deref(), Some("settings"));
    assert_eq!(
        plan.actions[1].request.selector.as_deref(),
        Some("button[data-testid='settings']")
    );
    assert!(plan.actions[1].request.force);
    assert_eq!(plan.actions[2].request.action, "waitFor");
    assert_eq!(
        plan.actions[2].request.selector.as_deref(),
        Some("[data-testid='api-keys']")
    );
    assert_eq!(plan.actions[2].request.timeout_ms, Some(9000));
    assert_eq!(plan.skipped_steps[0].action.as_deref(), Some("fillRef"));
    assert_eq!(plan.skipped_steps[0].reason, "redactedInputRequiresBinding");
    assert_eq!(plan.skipped_steps[1].action.as_deref(), Some("select"));
    assert_eq!(plan.skipped_steps[1].reason, "blockedByLiveBinding");
    assert_eq!(plan.skipped_steps[2].action.as_deref(), Some("press"));
    assert_eq!(plan.skipped_steps[2].reason, "blockedByLiveBinding");
    assert_eq!(plan.skipped_steps[3].action.as_deref(), Some("verify"));
    assert_eq!(plan.skipped_steps[3].reason, "blockedByLiveBinding");
    assert_eq!(
        plan.skipped_steps[4].action.as_deref(),
        Some("capturePageSecretToVault")
    );
    assert_eq!(plan.skipped_steps[4].reason, "blockedByLiveBinding");
    assert_eq!(plan.skipped_steps[5].action.as_deref(), Some("findText"));
    assert_eq!(plan.skipped_steps[5].reason, "blockedByLiveBinding");
}

#[test]
fn recipe_replay_plan_marks_live_vault_capture_as_binding_point() {
    let request = BrowserRecipeReplayRequest {
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [
                {
                    "action": "navigate",
                    "url": "https://example.com/"
                },
                {
                    "action": "capturePageSecretToVault",
                    "selector": "[data-testid='secret']"
                },
                {
                    "action": "clickRef",
                    "selector": "[data-testid='continue']"
                }
            ]
        })),
        dry_run: Some(false),
        ..BrowserRecipeReplayRequest::default()
    };

    let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

    assert_eq!(plan.steps_planned, 3);
    assert_eq!(plan.actions.len(), 1);
    assert_eq!(plan.actions[0].request.action, "navigate");
    assert_eq!(plan.skipped_steps.len(), 2);
    assert_eq!(
        plan.skipped_steps[0].action.as_deref(),
        Some("capturePageSecretToVault")
    );
    assert_eq!(
        plan.skipped_steps[0].reason,
        "liveVaultCaptureRequiresBinding"
    );
    assert_eq!(plan.skipped_steps[1].action.as_deref(), Some("clickRef"));
    assert_eq!(plan.skipped_steps[1].reason, "blockedByLiveBinding");
}

#[test]
fn recipe_replay_plan_skips_redacted_text_only_steps_as_live_binding_points() {
    let request = BrowserRecipeReplayRequest {
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [
                {
                    "action": "waitFor",
                    "valueRedacted": true
                },
                {
                    "action": "findText",
                    "queryRedacted": true
                }
            ]
        })),
        dry_run: Some(false),
        ..BrowserRecipeReplayRequest::default()
    };

    let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

    assert_eq!(plan.steps_planned, 2);
    assert!(plan.actions.is_empty());
    assert_eq!(plan.skipped_steps.len(), 2);
    assert_eq!(plan.skipped_steps[0].action.as_deref(), Some("waitFor"));
    assert_eq!(
        plan.skipped_steps[0].reason,
        "redactedTextRequiresFreshObservation"
    );
    assert_eq!(plan.skipped_steps[1].action.as_deref(), Some("findText"));
    assert_eq!(plan.skipped_steps[1].reason, "blockedByLiveBinding");
}

#[test]
fn recipe_replay_plan_preserves_decision_points_for_dry_run_responses() {
    let request = BrowserRecipeReplayRequest {
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [
                {
                    "action": "waitFor",
                    "valueRedacted": true
                }
            ]
        })),
        dry_run: Some(true),
        ..BrowserRecipeReplayRequest::default()
    };

    let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");

    assert!(
        plan.decision_points.iter().any(|point| {
            point.get("decisionId").and_then(|value| value.as_str())
                == Some("fresh-observation-after-redacted-text")
        }),
        "{:?}",
        plan.decision_points
    );
}

#[test]
fn recipe_replay_planned_step_results_are_ordered_for_agent_recovery() {
    let request = BrowserRecipeReplayRequest {
        recipe: Some(json!({
            "schemaVersion": 2,
            "steps": [
                {
                    "action": "navigate",
                    "url": "https://example.com/"
                },
                {
                    "action": "fillRef",
                    "selector": "#email",
                    "valueRedacted": true
                },
                {
                    "action": "clickRef",
                    "selector": "[data-testid='continue']"
                }
            ]
        })),
        dry_run: Some(true),
        ..BrowserRecipeReplayRequest::default()
    };

    let plan = browser_recipe_replay_plan(&request).expect("recipe plan builds");
    let results = browser_recipe_replay_planned_step_results(&plan);

    assert_eq!(results.len(), 3);
    assert_eq!(results[0].index, 0);
    assert_eq!(results[0].action.as_deref(), Some("navigate"));
    assert!(results[0].ok);
    assert_eq!(results[0].status, "planned");
    assert_eq!(results[1].index, 1);
    assert_eq!(results[1].action.as_deref(), Some("fillRef"));
    assert!(!results[1].ok);
    assert_eq!(results[1].status, "skipped");
    assert_eq!(
        results[1].reason.as_deref(),
        Some("redactedInputRequiresBinding")
    );
    assert_eq!(results[2].index, 2);
    assert_eq!(results[2].action.as_deref(), Some("clickRef"));
    assert_eq!(results[2].reason.as_deref(), Some("blockedByLiveBinding"));
}
