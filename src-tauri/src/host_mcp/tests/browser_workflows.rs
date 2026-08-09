use super::super::*;

#[test]
fn browser_workflow_summaries_resolve_bookmark_recipes_compactly() {
    let state = json!({
        "bookmarks": [
            {
                "bookmarkId": "wf-google-doc",
                "label": "Docs editing workflow",
                "url": "https://docs.example.invalid/",
                "category": "workflow",
                "kind": "link",
                "agentWorkflow": {
                    "recipeId": "browser-recipe-doc",
                    "recipePath": "/tmp/shellx-browser-recipes/doc.json",
                    "goal": "Open the document and update one heading",
                    "steps": 5,
                    "source": "recipe",
                    "health": "improved",
                    "driftStatus": "fresh"
                }
            },
            {
                "bookmarkId": "normal-bookmark",
                "label": "Normal bookmark",
                "url": "https://example.invalid/"
            }
        ],
        "bookmarkToolbar": [
            {
                "bookmarkId": "folder",
                "children": [{ "bookmarkId": "wf-google-doc" }]
            }
        ]
    });

    let filters = BrowserWorkflowFilters {
        query: Some("heading".to_string()),
        ..BrowserWorkflowFilters::default()
    };
    let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, 10);
    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0]["bookmarkId"], json!("wf-google-doc"));
    assert_eq!(workflows[0]["toolbarPinned"], json!(true));
    assert_eq!(
        workflows[0]["recipePath"],
        json!("/tmp/shellx-browser-recipes/doc.json")
    );
    assert_eq!(
        browser_workflow_recipe_path_from_bookmarks_state(&state, "wf-google-doc").as_deref(),
        Some("/tmp/shellx-browser-recipes/doc.json")
    );
    let summary = browser_workflows_text_summary(&json!({
        "ok": true,
        "count": workflows.len(),
        "workflows": workflows,
    }));
    assert!(summary.contains("Agent workflow bookmark"));
    assert!(summary.contains("wf-google-doc"));
}

#[test]
fn browser_workflow_apply_blocks_contract_drift() {
    let state = json!({
        "bookmarks": [
            {
                "bookmarkId": "wf-drifted",
                "label": "Drifted workflow",
                "category": "workflow",
                "agentWorkflow": {
                    "recipePath": "/tmp/shellx-browser-recipes/drifted.json",
                    "contractAuditStatus": "contract-drift",
                    "contractAuditReason": "Vault base contract changed after this workflow was recorded"
                }
            }
        ]
    });

    let workflow = browser_workflow_summary_from_bookmarks_state(&state, "wf-drifted")
        .expect("workflow summary");
    let reason = browser_workflow_contract_apply_block_reason(&workflow)
        .expect("drifted workflow is blocked");

    assert!(reason.contains("contract-drift"));
    assert!(reason.contains("Vault base contract changed"));
    assert_eq!(
        browser_workflow_recipe_path_from_bookmarks_state(&state, "wf-drifted").as_deref(),
        Some("/tmp/shellx-browser-recipes/drifted.json")
    );
}

#[test]
fn browser_workflow_apply_contract_guard_blocks_scope_mismatches() {
    let workflow = json!({
        "bookmarkId": "wf-api-key",
        "siteKey": "example.com",
        "contractProfile": "default-agent-signup",
        "permissionsNeeded": ["cookies.accept", "vault.secret.store"]
    });

    let domain_block = browser_workflow_apply_contract_block_reason(
        &json!({ "expectedDomains": ["safe.example"] }),
        &workflow,
    )
    .expect("domain mismatch blocks apply");
    assert!(domain_block.contains("expectedDomains"));
    assert!(domain_block.contains("example.com"));

    let profile_block = browser_workflow_apply_contract_block_reason(
        &json!({ "contractProfile": "nightly-expanded" }),
        &workflow,
    )
    .expect("contract profile mismatch blocks apply");
    assert!(profile_block.contains("contractProfile"));
    assert!(profile_block.contains("default-agent-signup"));

    let permission_block = browser_workflow_apply_contract_block_reason(
        &json!({ "allowedPermissions": ["cookies.accept"] }),
        &workflow,
    )
    .expect("missing permission blocks apply");
    assert!(permission_block.contains("allowedPermissions"));
    assert!(permission_block.contains("vault.secret.store"));

    assert!(browser_workflow_apply_contract_block_reason(
        &json!({
            "expectedDomains": ["sub.example.com", "example.com"],
            "contractProfile": "default-agent-signup",
            "allowedPermissions": ["cookies.accept", "vault.secret.store"]
        }),
        &workflow,
    )
    .is_none());
}

#[test]
fn browser_workflow_replay_metadata_update_marks_drift_from_step_results() {
    let workflow = json!({
        "bookmarkId": "wf-api-key",
        "label": "Get API key",
        "url": "https://example.com/settings/api",
        "category": "workflow",
        "kind": "link",
        "siteKey": "example.com",
        "taskType": "get",
        "target": "api-key",
        "surface": "settings",
        "recipeId": "browser-recipe-1",
        "recipePath": "/tmp/shellx-browser-recipes/api-key.json",
        "goal": "Get API key",
        "steps": 4,
        "source": "recipe",
        "contractAuditStatus": "fresh",
        "permissionsNeeded": ["cookies.accept"],
        "secretKinds": ["apiToken"]
    });
    let replay = json!({
        "ok": true,
        "status": "completed",
        "stepsPlanned": 4,
        "stepsApplied": 2,
        "stepsSkipped": 1,
        "stepResults": [
            { "index": 0, "action": "navigate", "ok": true, "status": "applied" },
            { "index": 1, "action": "clickRef", "ok": false, "status": "notActionable", "reason": "actionNotApplied" }
        ]
    });

    let body = browser_workflow_replay_metadata_update_body(
        "wf-api-key",
        &workflow,
        &replay,
        false,
        1_725_000_000_000,
    )
    .expect("apply replay updates workflow metadata");

    assert_eq!(body["bookmarkId"], json!("wf-api-key"));
    assert_eq!(body["label"], json!("Get API key"));
    assert_eq!(body["agentWorkflow"]["siteKey"], json!("example.com"));
    assert_eq!(body["agentWorkflow"]["taskType"], json!("get"));
    assert_eq!(body["agentWorkflow"]["target"], json!("api-key"));
    assert_eq!(body["agentWorkflow"]["health"], json!("degraded"));
    assert_eq!(body["agentWorkflow"]["driftStatus"], json!("drifted"));
    assert_eq!(body["agentWorkflow"]["lastReplayStatus"], json!("failed"));
    assert_eq!(
        body["agentWorkflow"]["lastReplayAtMs"],
        json!(1_725_000_000_000i64)
    );
    assert!(body["agentWorkflow"]["refreshReason"]
        .as_str()
        .is_some_and(|value| value.contains("stepResults")));
}

#[test]
fn browser_workflow_replay_summary_mentions_decision_points() {
    let replay = json!({
        "status": "dryRunCompleted",
        "stepsPlanned": 4,
        "stepsApplied": 0,
        "stepsSkipped": 1,
        "decisionPoints": [
            { "decisionId": "domain-or-redirect-variant" },
            { "decisionId": "fresh-observation-after-redacted-text" }
        ]
    });

    let summary = browser_workflow_replay_summary_text(&replay, true, "/tmp/recipe.json");

    assert!(summary.contains("decisionPoints=2"), "{summary}");
}

#[test]
fn browser_workflow_summaries_filter_by_taxonomy_and_aliases() {
    let state = json!({
        "bookmarks": [
            {
                "bookmarkId": "wf-google-api-key",
                "label": "Google AI Studio API key",
                "url": "https://aistudio.google.com/app/apikey",
                "category": "workflow",
                "kind": "link",
                "agentWorkflow": {
                    "siteKey": "google.com",
                    "taskType": "get",
                    "target": "api-key",
                    "surface": "ai-studio",
                    "aliases": ["gemini key", "developer token"],
                    "contractProfile": "default-agent-signup",
                    "permissionsNeeded": ["cookies.accept", "vault.secret.store"],
                    "secretKinds": ["apiToken"],
                    "recipeId": "browser-recipe-google-api-key",
                    "recipePath": "/tmp/shellx-browser-recipes/google-api-key.json",
                    "goal": "Get a Google AI Studio API key and store it in Vault",
                    "steps": 8,
                    "source": "recipe",
                    "health": "fresh",
                    "driftStatus": "fresh"
                }
            },
            {
                "bookmarkId": "wf-google-drive-upload",
                "label": "Google Drive upload",
                "url": "https://drive.google.com/",
                "category": "workflow",
                "kind": "link",
                "agentWorkflow": {
                    "siteKey": "google.com",
                    "taskType": "upload",
                    "target": "file",
                    "surface": "drive",
                    "aliases": ["drive file upload"],
                    "recipePath": "/tmp/shellx-browser-recipes/google-drive-upload.json",
                    "health": "fresh"
                }
            },
            {
                "bookmarkId": "wf-github-search",
                "label": "GitHub repo search",
                "url": "https://github.com/search",
                "category": "workflow",
                "kind": "link",
                "agentWorkflow": {
                    "siteKey": "github.com",
                    "taskType": "search",
                    "target": "repo",
                    "surface": "github-search",
                    "recipePath": "/tmp/shellx-browser-recipes/github-search.json",
                    "health": "fresh"
                }
            }
        ],
        "bookmarkToolbar": []
    });

    let filters = BrowserWorkflowFilters {
        site_key: Some("google.com".to_string()),
        task_type: Some("get".to_string()),
        target: Some("api key".to_string()),
        query: Some("gemini".to_string()),
        ..BrowserWorkflowFilters::default()
    };
    let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, 10);

    assert_eq!(workflows.len(), 1);
    assert_eq!(workflows[0]["bookmarkId"], json!("wf-google-api-key"));
    assert_eq!(workflows[0]["siteKey"], json!("google.com"));
    assert_eq!(workflows[0]["taskType"], json!("get"));
    assert_eq!(workflows[0]["target"], json!("api-key"));
    assert_eq!(workflows[0]["surface"], json!("ai-studio"));
    assert_eq!(
        workflows[0]["contractProfile"],
        json!("default-agent-signup")
    );
    assert_eq!(
        workflows[0]["permissionsNeeded"],
        json!(["cookies.accept", "vault.secret.store"])
    );
    assert_eq!(workflows[0]["secretKinds"], json!(["apiToken"]));

    let intent_filters = BrowserWorkflowFilters {
        task_type: Some("upload".to_string()),
        target: Some("file".to_string()),
        ..BrowserWorkflowFilters::default()
    };
    let intent_workflows =
        browser_workflow_summaries_from_bookmarks_state(&state, &intent_filters, 10);
    assert_eq!(intent_workflows.len(), 1);
    assert_eq!(
        intent_workflows[0]["bookmarkId"],
        json!("wf-google-drive-upload")
    );
}

#[test]
fn browser_workflow_taxonomy_preserves_signup_intent() {
    assert_eq!(
        canonical_workflow_task_type(Some("sign-up".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("signup".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("sign-in".to_string())).as_deref(),
        Some("login")
    );
}

#[test]
fn browser_action_body_preserves_debug_api_contract_fields() {
    let body = browser_action_body(
        "clickRef",
        json!({
            "browserTabId": "browser-tab-1",
            "taskId": "task-1",
            "refId": "ref-7",
            "lockLeaseId": "lease-1",
            "ownerAgentId": "agent-1",
            "ownerRunId": "run-1"
        }),
    )
    .expect("click body");
    assert_eq!(body["action"], json!("clickRef"));
    assert_eq!(body["browserTabId"], json!("browser-tab-1"));
    assert_eq!(body["taskId"], json!("task-1"));
    assert_eq!(body["refId"], json!("ref-7"));
    assert_eq!(body["lockLeaseId"], json!("lease-1"));
    assert_eq!(body["ownerAgentId"], json!("agent-1"));
    assert_eq!(body["ownerRunId"], json!("run-1"));

    let navigate_body = browser_action_body(
        "navigate",
        json!({
            "browserTabId": "browser-tab-1",
            "taskId": "task-1",
            "url": "https://example.com/"
        }),
    )
    .expect("navigate body");
    assert_eq!(navigate_body["action"], json!("navigate"));
    assert_eq!(navigate_body["browserTabId"], json!("browser-tab-1"));
    assert_eq!(navigate_body["taskId"], json!("task-1"));
    assert_eq!(navigate_body["url"], json!("https://example.com/"));

    let vault_fill_body = browser_action_body(
        "fillFromVaultGrant",
        json!({
            "browserTabId": "browser-tab-1",
            "taskId": "task-1",
            "refId": "password",
            "grantId": "grant-password",
            "secretRef": "agent-test@example.invalid"
        }),
    )
    .expect("vault fill body");
    assert_eq!(vault_fill_body["action"], json!("fillFromVaultGrant"));
    assert_eq!(vault_fill_body["taskId"], json!("task-1"));
    assert_eq!(vault_fill_body["grantId"], json!("grant-password"));
    assert_eq!(
        vault_fill_body["secretRef"],
        json!("agent-test@example.invalid")
    );

    let screenshot_body = browser_action_body(
        "captureScreenshot",
        json!({
            "taskId": "task-1",
            "fullPage": true
        }),
    )
    .expect("screenshot body");
    assert_eq!(screenshot_body["action"], json!("captureScreenshot"));
    assert_eq!(screenshot_body["taskId"], json!("task-1"));
    assert_eq!(screenshot_body["fullPage"], json!(true));
}

#[test]
fn browser_extract_format_maps_table_to_extract_table() {
    assert_eq!(
        browser_extract_action_from_format(None).expect("default format"),
        "extractText"
    );
    assert_eq!(
        browser_extract_action_from_format(Some("md")).expect("markdown alias"),
        "extractMarkdown"
    );
    assert_eq!(
        browser_extract_action_from_format(Some("table")).expect("table format"),
        "extractTable"
    );
    let unsupported = browser_extract_action_from_format(Some("pdf"))
        .expect_err("unsupported extract formats are explicit");
    assert!(unsupported.contains("Use text, markdown, or table"));
}

#[test]
fn browser_mcp_force_click_recovery_is_narrow_and_safe() {
    let body = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-7"
    });
    let covered = json!({
        "ok": false,
        "status": "notActionable",
        "actionability": {
            "failedChecks": ["receivesEvents"]
        }
    });
    let retry = browser_mcp_force_click_recovery_body("clickRef", &body, &covered)
        .expect("covered click can be retried with force");
    assert_eq!(retry["force"], json!(true));
    assert_eq!(retry["refId"], json!("dom-7"));

    let mixed_failure = json!({
        "ok": false,
        "status": "notActionable",
        "actionability": {
            "failedChecks": ["visible", "receivesEvents"]
        }
    });
    assert!(browser_mcp_force_click_recovery_body("clickRef", &body, &mixed_failure).is_none());

    let already_forced = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-7",
        "force": true
    });
    assert!(browser_mcp_force_click_recovery_body("clickRef", &already_forced, &covered).is_none());

    let sensitive = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-7",
        "secretRef": "service/api-key"
    });
    assert!(browser_mcp_force_click_recovery_body("clickRef", &sensitive, &covered).is_none());

    let approval = json!({
        "ok": false,
        "status": "notActionable",
        "requiredApproval": "browser-transfer",
        "actionability": {
            "failedChecks": ["receivesEvents"]
        }
    });
    assert!(browser_mcp_force_click_recovery_body("clickRef", &body, &approval).is_none());
}

#[test]
fn browser_mcp_locator_candidate_recovery_is_strict_and_safe() {
    let body = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-old"
    });
    let stale = json!({
        "ok": false,
        "status": "notFound",
        "stepSummary": {
            "locatorCandidates": [
                {
                    "refId": "dom-new",
                    "selector": "[data-testid='submit']",
                    "action": "clickRef",
                    "visible": true,
                    "enabled": true,
                    "strictMatchCount": 1
                }
            ]
        }
    });
    let (retry, recovery) = browser_mcp_locator_candidate_recovery_body("clickRef", &body, &stale)
        .expect("strict visible candidate can recover stale click refs");
    assert_eq!(retry["selector"], json!("[data-testid='submit']"));
    assert_eq!(retry["refId"], json!("dom-new"));
    assert_eq!(recovery["strategy"], json!("strictLocator"));
    assert_eq!(recovery["candidateRefId"], json!("dom-new"));

    let broad_candidate = json!({
        "ok": false,
        "status": "notFound",
        "stepSummary": {
            "locatorCandidates": [
                {
                    "refId": "dom-new",
                    "selector": "button",
                    "action": "clickRef",
                    "visible": true,
                    "enabled": true,
                    "strictMatchCount": 2
                }
            ]
        }
    });
    assert!(
        browser_mcp_locator_candidate_recovery_body("clickRef", &body, &broad_candidate).is_none()
    );

    let hidden_candidate = json!({
        "ok": false,
        "status": "notFound",
        "stepSummary": {
            "locatorCandidates": [
                {
                    "refId": "dom-new",
                    "selector": "#hidden",
                    "action": "clickRef",
                    "visible": false,
                    "enabled": true,
                    "strictMatchCount": 1
                }
            ]
        }
    });
    assert!(
        browser_mcp_locator_candidate_recovery_body("clickRef", &body, &hidden_candidate).is_none()
    );

    let unsafe_failure = json!({
        "ok": false,
        "status": "notActionable",
        "actionability": {
            "failedChecks": ["visible"]
        },
        "stepSummary": {
            "locatorCandidates": [
                {
                    "refId": "dom-new",
                    "selector": "#visible-alternative",
                    "action": "clickRef",
                    "visible": true,
                    "enabled": true,
                    "strictMatchCount": 1
                }
            ]
        }
    });
    assert!(
        browser_mcp_locator_candidate_recovery_body("clickRef", &body, &unsafe_failure).is_none()
    );

    let explicit_selector = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-old",
        "selector": "#already-targeted"
    });
    assert!(
        browser_mcp_locator_candidate_recovery_body("clickRef", &explicit_selector, &stale)
            .is_none()
    );

    let sensitive = json!({
        "action": "clickRef",
        "taskId": "task-1",
        "refId": "dom-old",
        "secretRef": "service/api-key"
    });
    assert!(browser_mcp_locator_candidate_recovery_body("clickRef", &sensitive, &stale).is_none());
    assert!(browser_mcp_locator_candidate_recovery_body("fillRef", &body, &stale).is_none());
}

#[test]
fn browser_recovery_policy_matches_shared_reliability_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/browser-reliability-cases.json"
    ))
    .expect("browser reliability fixture parses");
    for case in fixture["recoveryCases"].as_array().expect("recovery cases") {
        let name = case["name"].as_str().expect("case name");
        let action = case["action"].as_str().expect("case action");
        let body = &case["body"];
        let response = &case["response"];
        let strategy = browser_mcp_locator_candidate_recovery_body(action, body, response)
            .map(|(_, evidence)| {
                evidence["strategy"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .or_else(|| {
                browser_mcp_force_click_recovery_body(action, body, response)
                    .map(|_| "forceClick".to_string())
            });
        assert_eq!(
            strategy.as_deref(),
            case["expectedStrategy"].as_str(),
            "{name}"
        );
    }
}
