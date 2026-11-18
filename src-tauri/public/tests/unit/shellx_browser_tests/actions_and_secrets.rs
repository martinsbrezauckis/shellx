use super::super::*;
use crate::shellx_browser_actions::EngineControlResult;

#[test]
fn browser_vault_deposit_keys_are_owned_and_never_caller_selected() {
    assert_eq!(
        crate::shellx_browser_vault::browser_vault_deposit_key(
            "bank/password",
            "browser-deposit-fixed"
        ),
        "browser-deposits/bank-password-browser-deposit-fixed"
    );
    assert_eq!(
        crate::shellx_browser_vault::browser_vault_deposit_key("---", "browser-deposit-fixed"),
        "browser-deposits/secret-browser-deposit-fixed"
    );
}

#[test]
fn vault_deposit_prepares_before_any_registry_commit() {
    let registry = ShellxBrowserRegistry::default();
    let invalid = BrowserVaultDepositRequest {
        label: "   ".to_string(),
        secret_value: "must-never-be-written".to_string(),
        ..BrowserVaultDepositRequest::default()
    };
    assert_eq!(
        registry.prepare_vault_deposit(invalid).err().as_deref(),
        Some("vault deposit label is required")
    );
    assert!(registry.vault_deposits(None).is_empty());
    assert!(registry.receipts(None).is_empty());
    let oversized = BrowserVaultDepositRequest {
        label: "Owned oversized secret".to_string(),
        secret_value: "x".repeat(4_097),
        ..BrowserVaultDepositRequest::default()
    };
    assert_eq!(
        registry.prepare_vault_deposit(oversized).err().as_deref(),
        Some("vault deposit secretValue exceeds the 4096 byte limit")
    );
    assert!(registry.vault_deposits(None).is_empty());
    assert!(registry.receipts(None).is_empty());

    let marker = "SX_VAULT_DEPOSIT_SECRET_MARKER";
    let request = BrowserVaultDepositRequest {
        task_id: Some("browser-task-owned".to_string()),
        label: "  Owned   login  ".to_string(),
        secret_value: marker.to_string(),
        source_url: Some("https://example.test/login".to_string()),
    };
    let prepared = registry
        .prepare_vault_deposit(request)
        .expect("valid deposit prepares");
    assert_eq!(prepared.label(), "Owned   login");
    assert!(
        registry.vault_deposits(None).is_empty(),
        "preparation must not mutate the registry before the Vault write succeeds"
    );
    assert!(registry.receipts(None).is_empty());

    let response = registry.commit_prepared_vault_deposit(
        prepared,
        "browser-deposits/owned".to_string(),
        Some("hostMediated"),
    );
    assert_eq!(response.label, "Owned   login");
    assert_eq!(response.task_id.as_deref(), Some("browser-task-owned"));
    assert_eq!(
        response.vault_ref.as_deref(),
        Some("browser-deposits/owned")
    );
    assert!(!response.secret_exposed);
    assert!(response.deposit_id.starts_with("browser-deposit-"));
    assert_eq!(response.server_receipt.id, response.deposit_id);
    assert_eq!(
        response.server_receipt.payload_hash,
        response.storage_commit_hash
    );
    assert!(response.server_receipt.created_ms > 0);
    assert!(response
        .server_receipt
        .from_token
        .starts_with("browser-agent-token:"));
    assert_eq!(response.receipt.kind, "browserVaultDepositCreated");
    assert_eq!(
        response.receipt.evidence.get("vaultWriteCommitted"),
        Some(&serde_json::json!(true))
    );
    assert_eq!(
        response.receipt.evidence.get("captureMode"),
        Some(&serde_json::json!("hostMediated"))
    );
    let stored = registry.vault_deposits(None);
    assert_eq!(stored.len(), 1);
    assert_eq!(
        stored[0].vault_ref.as_deref(),
        response.vault_ref.as_deref()
    );
    assert_eq!(stored[0].receipt.evidence, response.receipt.evidence);
    assert_eq!(registry.receipts(None).len(), 1);
    assert!(response.receipt.evidence.get("secretValue").is_none());
    assert!(
        !serde_json::to_string(&response)
            .expect("deposit response serializes")
            .contains(marker),
        "deposit response and receipt must never serialize the secret value"
    );
    assert!(
        !serde_json::to_string(&registry.state())
            .expect("Browser state serializes")
            .contains(marker),
        "Browser state must never retain the secret value"
    );
}

#[test]
fn recipe_export_records_active_tab_engine_action_steps() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Record a form fill as a reusable recipe".to_string(),
            start_url: Some("https://example.com/form".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .active_browser_tab_id
        .expect("task has active tab");

    {
        let mut state = lock_or_recover(&registry.state);
        state.engine.url = Some("https://example.com/form".to_string());
        state.engine.profile_id = Some("agent-work".to_string());
        state.engine.load_status = "loaded".to_string();
    }

    let action = registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "fillRef".to_string(),
                ref_id: Some("email".to_string()),
                selector: Some("#email".to_string()),
                value: Some("user@example.test".to_string()),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                url: Some("https://example.com/form".to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("engine result is recorded");
    assert_eq!(action.receipt.kind, "browserEngineActionApplied");
    assert_eq!(
        action
            .receipt
            .evidence
            .get("browserTabId")
            .and_then(|value| value.as_str()),
        Some(tab_id.as_str())
    );

    let recipe = registry
        .export_recipe(BrowserRecipeExportRequest {
            task_id: Some(task.task_id),
            reason: Some("regression coverage".to_string()),
            ..BrowserRecipeExportRequest::default()
        })
        .expect("recipe exports");
    assert!(
        recipe.steps > 0,
        "task-scoped recipe export should retain active-tab engine action receipts"
    );

    let recipe_json =
        std::fs::read_to_string(&recipe.path).expect("recipe artifact should be readable");
    let recipe_value: serde_json::Value =
        serde_json::from_str(&recipe_json).expect("recipe artifact is JSON");
    let steps = recipe_value
        .get("steps")
        .and_then(|value| value.as_array())
        .expect("recipe has steps");
    assert!(steps.iter().any(|step| {
        step.get("action").and_then(|value| value.as_str()) == Some("fillRef")
            && step.get("browserTabId").and_then(|value| value.as_str()) == Some(tab_id.as_str())
            && step.get("valueRedacted").and_then(|value| value.as_bool()) == Some(true)
    }));
    assert!(
        !recipe_json.contains("user@example.test"),
        "recipe export must not write raw typed values"
    );
}

#[test]
fn taskless_user_tab_engine_actions_record_without_browser_task() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/results".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("personal tab opens")
        .tab;
    {
        let mut state = lock_or_recover(&registry.state);
        let engine_idx = state
            .engine_pool
            .engines
            .iter()
            .position(|engine| engine.engine_id == tab.engine_id)
            .expect("tab has an allocated engine");
        {
            let engine = &mut state.engine_pool.engines[engine_idx];
            engine.mounted = true;
            engine.url = tab.url.clone();
            engine.pending_url = None;
            engine.profile_id = Some(tab.profile_id.clone());
            engine.load_status = "loaded".to_string();
        }
        state.engine = state.engine_pool.engines[engine_idx].clone();
    }

    let response = registry
        .record_engine_control_result(
            BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id.clone()),
                action: "goBack".to_string(),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                message: Some("history.back requested".to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("taskless tab action records without requiring a Browser task");

    assert!(response.ok);
    assert_eq!(response.task_id, None);
    assert_eq!(
        response.current_url.as_deref(),
        Some("https://example.com/results")
    );
    assert_eq!(response.receipt.kind, "browserEngineActionApplied");
    assert_eq!(response.receipt.task_id, None);
    assert_eq!(response.receipt.profile_id.as_deref(), Some("personal"));
    assert!(response.step_summary.is_none());
}

#[test]
fn taskless_user_tab_screenshots_skip_task_secret_gate() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/results".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("personal tab opens")
        .tab;

    let response = registry
        .block_screenshot_if_protected_values(&BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            action: "captureScreenshot".to_string(),
            screenshot_full_page: true,
            ..BrowserActionRequest::default()
        })
        .expect("taskless screenshot gate should not require an active Browser task");

    assert!(response.is_none());
}

#[test]
fn taskless_user_tab_vault_fill_redacts_observe_and_blocks_screenshot() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/login".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("personal tab opens")
        .tab;
    {
        let mut state = lock_or_recover(&registry.state);
        let engine_idx = state
            .engine_pool
            .engines
            .iter()
            .position(|engine| engine.engine_id == tab.engine_id)
            .expect("tab has an allocated engine");
        {
            let engine = &mut state.engine_pool.engines[engine_idx];
            engine.mounted = true;
            engine.url = tab.url.clone();
            engine.pending_url = None;
            engine.profile_id = Some(tab.profile_id.clone());
            engine.load_status = "loaded".to_string();
        }
        state.engine = state.engine_pool.engines[engine_idx].clone();
    }

    let marker = "Summer2024Riga!";
    let fill = registry
        .record_engine_control_result(
            BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id.clone()),
                action: "fillRef".to_string(),
                ref_id: Some("password".to_string()),
                value: Some(marker.to_string()),
                sensitive_kind: Some("vaultTainted".to_string()),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                url: Some("https://example.com/login".to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("manual Vault fill records on user tab");
    assert!(fill.ok);

    let observe = registry
        .record_engine_observation(
            BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            },
            "observe",
            BrowserObservation {
                task_id: tab.browser_tab_id.clone(),
                snapshot_id: String::new(),
                delta: None,
                url: Some("https://example.com/login".to_string()),
                title: "Login".to_string(),
                markdown: format!("# Login\n\nEcho {marker}"),
                text: format!("Echo {marker}"),
                refs: Vec::new(),
                dom_summary: BrowserDomSummary::default(),
                form_fields: vec![BrowserFormField {
                    ref_id: Some("password".to_string()),
                    label: "Password".to_string(),
                    field_kind: "password".to_string(),
                    selector: Some("input[type=password]".to_string()),
                    value: Some(marker.to_string()),
                    required: true,
                    disabled: false,
                    autocomplete: Some("current-password".to_string()),
                    form_action: None,
                }],
                form_field_groups: Vec::new(),
                accessibility_tree: Vec::new(),
                privacy_stats: None,
                untrusted_input: true,
                requires_engine: false,
            },
        )
        .expect("taskless observation records");
    let observe_json = serde_json::to_string(&observe).expect("observe serializes");
    assert!(
        !observe_json.contains(marker),
        "manual user-tab Vault fill must redact later user-tab observations"
    );
    assert!(observe_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

    let screenshot = registry
        .block_screenshot_if_protected_values(&BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id),
            action: "captureScreenshot".to_string(),
            screenshot_full_page: true,
            ..BrowserActionRequest::default()
        })
        .expect("screenshot gate evaluates")
        .expect("screenshot is blocked after user-tab Vault fill");
    assert_eq!(screenshot.status, "blocked");
    assert_eq!(
        screenshot.required_approval.as_deref(),
        Some("secretScreenshotReview")
    );
}

#[test]
fn taskless_user_tab_vault_fill_blocks_insecure_pages() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("http://127.0.0.1/login".to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..BrowserTabOpenRequest::default()
        })
        .expect("personal local tab opens")
        .tab;

    let blocked = registry
        .credential_entry_denial_for_action(&BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id),
            action: "fillFromVaultGrant".to_string(),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("taskless credential gate evaluates")
        .expect("insecure local credential fill is blocked");

    assert_eq!(blocked.status, "blocked");
    assert_eq!(blocked.task_id, None);
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("insecureCredentialEntryApproval")
    );
    assert_eq!(
        blocked
            .security_state
            .as_ref()
            .map(|state| state.scheme.as_str()),
        Some("http")
    );
}

#[test]
fn vault_fill_grant_action_becomes_internal_redacted_fill() {
    let original = BrowserActionRequest {
        task_id: Some("browser-task-1".to_string()),
        action: "fillFromVaultGrant".to_string(),
        ref_id: Some("password".to_string()),
        selector: Some("input[type=password]".to_string()),
        grant_id: Some("grant-password".to_string()),
        secret_ref: Some("agent-test@example.invalid".to_string()),
        expected_origin: Some("https://example.com".to_string()),
        ..BrowserActionRequest::default()
    };

    let prepared = prepare_vault_grant_fill_action(original, "super-secret-password".to_string())
        .expect("grant fill action is prepared");

    assert_eq!(prepared.action, "fillRef");
    assert_eq!(prepared.ref_id.as_deref(), Some("password"));
    assert_eq!(prepared.selector.as_deref(), Some("input[type=password]"));
    assert_eq!(prepared.value.as_deref(), Some("super-secret-password"));
    assert_eq!(prepared.grant_id.as_deref(), Some("grant-password"));
    assert_eq!(
        prepared.secret_ref.as_deref(),
        Some("agent-test@example.invalid")
    );
    assert_eq!(prepared.sensitive_kind.as_deref(), Some("vaultTainted"));
    assert_eq!(
        prepared.expected_origin.as_deref(),
        Some("https://example.com")
    );
}

#[test]
fn host_mediated_secret_fill_redacts_later_agent_outputs() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Fill a generic token field".to_string(),
            start_url: Some("https://example.com/form".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://example.com/form".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.url = Some("https://example.com/form".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
    }

    let marker = "SXKEYLEAK-tok-9f3a2b1c8d7e6f5a";
    let fill = registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "fillRef".to_string(),
                ref_id: Some("dom-1".to_string()),
                selector: Some("input[name=custname]".to_string()),
                value: Some(marker.to_string()),
                sensitive_kind: Some("vaultTainted".to_string()),
                grant_id: Some("grant-token".to_string()),
                secret_ref: Some("audit/leak-key".to_string()),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                url: Some("https://example.com/form".to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("secret fill is recorded");
    assert!(fill.ok);

    let observe = registry
        .record_engine_observation(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            },
            "observe",
            BrowserObservation {
                task_id: task.task_id.clone(),
                snapshot_id: String::new(),
                delta: None,
                url: Some("https://example.com/form".to_string()),
                title: "Form".to_string(),
                markdown: format!("# Form\n\nVisible echo {marker}"),
                text: format!("Visible echo {marker}"),
                refs: vec![BrowserObservationRef {
                    ref_id: "dom-1".to_string(),
                    role: "textbox".to_string(),
                    label: format!("Customer {marker}"),
                    name: Some(format!("Customer {marker}")),
                    test_id: None,
                    selector: Some("input[name=custname]".to_string()),
                    raw_selector: None,
                    raw_locator: None,
                    fingerprint: Some("fp-customer-input".to_string()),
                    dom_path: Some("html > body > input[name=\"custname\"]".to_string()),
                    frame_url: Some("https://example.com/form".to_string()),
                    shadow_path: Vec::new(),
                    option_values: Vec::new(),
                    value: Some(marker.to_string()),
                    action: Some("fillRef".to_string()),
                    locator_suggestions: vec![BrowserLocatorSuggestion {
                        kind: "text".to_string(),
                        value: marker.to_string(),
                        strict: false,
                        match_count: 1,
                    }],
                    bounds: None,
                    visible: Some(true),
                    enabled: Some(true),
                    editable: Some(true),
                    frame_id: Some("main".to_string()),
                    strict_match_count: Some(1),
                }],
                dom_summary: BrowserDomSummary {
                    text_bytes: marker.len(),
                    inputs: 1,
                    ..BrowserDomSummary::default()
                },
                form_fields: vec![BrowserFormField {
                    ref_id: Some("dom-1".to_string()),
                    label: format!("Customer {marker}"),
                    field_kind: "text".to_string(),
                    selector: Some("input[name=custname]".to_string()),
                    value: Some(marker.to_string()),
                    required: false,
                    disabled: false,
                    autocomplete: None,
                    form_action: Some("https://example.com/post".to_string()),
                }],
                form_field_groups: Vec::new(),
                accessibility_tree: vec![BrowserAccessibilityNode {
                    ref_id: Some("dom-1".to_string()),
                    role: "textbox".to_string(),
                    label: marker.to_string(),
                    selector: Some("input[name=custname]".to_string()),
                    action: Some("fillRef".to_string()),
                }],
                privacy_stats: None,
                untrusted_input: true,
                requires_engine: false,
            },
        )
        .expect("observation is recorded");
    let observe_json = serde_json::to_string(&observe).expect("observe serializes");
    assert!(
        !observe_json.contains(marker),
        "observe response must not expose a host-mediated durable secret"
    );
    assert!(observe_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

    let verify = registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "verify".to_string(),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                verification: Some(BrowserVerificationResult {
                    expectation_type: "text".to_string(),
                    passed: true,
                    selector: None,
                    checked_text: Some(format!("Posted JSON echoed {marker}")),
                    checked_url: Some("https://example.com/post".to_string()),
                    failures: Vec::new(),
                }),
                find_result: Some(BrowserFindTextResult {
                    query: "echoed".to_string(),
                    match_count: 1,
                    active_index: Some(0),
                    snippet: Some(format!("Posted JSON echoed {marker}")),
                    scrolled: false,
                    case_sensitive: false,
                }),
                extracted_text: Some(format!("Posted JSON echoed {marker}")),
                ..EngineControlResult::default()
            },
        )
        .expect("verification is recorded");
    let verify_json = serde_json::to_string(&verify).expect("verify serializes");
    assert!(
        !verify_json.contains(marker),
        "control-result response must not expose a host-mediated durable secret"
    );
    assert!(verify_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

    let screenshot = registry
        .block_screenshot_if_protected_values(&BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "captureScreenshot".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("screenshot gate evaluates")
        .expect("screenshot is blocked after mediated secret fill");
    assert_eq!(screenshot.status, "blocked");
    assert_eq!(
        screenshot.required_approval.as_deref(),
        Some("secretScreenshotReview")
    );
}

#[test]
fn redacted_observation_url_does_not_pollute_browser_state() {
    let registry = ShellxBrowserRegistry::default();
    let raw_url = "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F";
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open Gmail sign-in".to_string(),
            start_url: Some(raw_url.to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["accounts.google.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some(raw_url.to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.url = Some(raw_url.to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let response = registry
        .record_engine_observation(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            },
            "observe",
            BrowserObservation {
                task_id: task.task_id.clone(),
                snapshot_id: String::new(),
                delta: None,
                url: Some(raw_url.to_string()),
                title: "Sign in - Google Accounts".to_string(),
                text: "Email or phone".to_string(),
                markdown: "Email or phone".to_string(),
                refs: Vec::new(),
                dom_summary: BrowserDomSummary::default(),
                form_fields: Vec::new(),
                form_field_groups: Vec::new(),
                accessibility_tree: Vec::new(),
                privacy_stats: None,
                untrusted_input: true,
                requires_engine: false,
            },
        )
        .expect("observation records");
    assert!(
        response
            .observation
            .as_ref()
            .and_then(|observation| observation.url.as_deref())
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
        "agent-facing observation keeps query redacted"
    );
    assert!(
        response
            .current_url
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
        "agent-facing current URL keeps query redacted"
    );

    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab is present");
    assert_eq!(tab.url.as_deref(), Some(raw_url));
    assert_eq!(state.engine.url.as_deref(), Some(raw_url));
    let task_snapshot = state
        .tasks
        .iter()
        .find(|snapshot| snapshot.task_id == task.task_id)
        .expect("task snapshot is present");
    assert_eq!(task_snapshot.current_url.as_deref(), Some(raw_url));
}

#[test]
fn engine_context_mismatch_error_redacts_url_query() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Notion popup redirect".to_string(),
            start_url: Some("https://app.notion.com/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["app.notion.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.browser_tab_id = Some("stale-other-tab".to_string());
            engine.url = Some("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FcallbackType%3Dpopup%26requestId%3Dsecret-state".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let state = lock_or_recover(&registry.state);
    let err = ensure_engine_task_matches_active_context(&state, &task.task_id)
        .expect_err("engine/tab mismatch should be reported");
    drop(state);
    assert!(
        err.contains("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect"),
        "error keeps useful origin/path context"
    );
    assert!(
        !err.contains("redirectUri") && !err.contains("requestId") && !err.contains("secret-state"),
        "error must not expose OAuth query or state parameters: {err}"
    );
}

#[test]
fn same_tab_oauth_redirect_mismatch_is_allowed_for_state_healing() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Figma Google redirect".to_string(),
            start_url: Some("https://www.figma.com/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "www.figma.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let tab_id = state.tabs[tab_idx].browser_tab_id.clone();
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://www.figma.com/login".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.browser_tab_id = Some(tab_id);
            engine.task_id = Some(task.task_id.clone());
            engine.url = Some("https://accounts.google.com/v3/signin/accountchooser?client_id=secret-client&state=secret-state".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let state = lock_or_recover(&registry.state);
    ensure_engine_task_matches_active_context(&state, &task.task_id)
        .expect("same tab/task engine redirect should be allowed so observation can heal state");
}

#[test]
fn same_allocated_engine_redirect_with_lagging_owner_metadata_is_allowed() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Notion Google redirect".to_string(),
            start_url: Some("https://app.notion.com/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "app.notion.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.browser_tab_id = None;
            engine.task_id = None;
            engine.url = Some("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FcallbackType%3Dpopup%26requestId%3Dsecret-state".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let state = lock_or_recover(&registry.state);
    ensure_engine_task_matches_active_context(&state, &task.task_id)
        .expect("same allocated engine redirect should be allowed while owner metadata catches up");
}
