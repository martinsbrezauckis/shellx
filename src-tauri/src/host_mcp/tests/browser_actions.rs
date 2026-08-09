use super::super::*;

#[test]
fn browser_tool_catalog_has_a_measured_serialized_budget() {
    let specs = browser_entry_tool_specs();
    let bytes = serde_json::to_vec(&specs).unwrap().len();
    eprintln!(
        "Browser tool catalog: {} tools, {} serialized bytes",
        specs.len(),
        bytes
    );
    assert_eq!(specs.len(), 2);
    assert!(
        bytes <= 6_000,
        "advertised Browser catalog is {bytes} bytes"
    );
}

#[test]
fn browser_evidence_actions_stay_routed_searchable_and_write_gated() {
    let advertised_names = browser_entry_tool_specs()
        .into_iter()
        .filter_map(|spec| spec.get("name").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    let searchable_names = browser_tool_specs()
        .into_iter()
        .filter_map(|spec| spec.get("name").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    assert_eq!(advertised_names, ["browser_read", "browser_act"]);
    for name in [
        "browser_evidence",
        "browser_flight_recorder_export",
        "browser_evaluation_write",
    ] {
        assert!(searchable_names.iter().any(|candidate| candidate == name));
    }
    assert!(!is_write_class_tool("browser_evidence"));
    assert!(is_write_class_tool("browser_flight_recorder_export"));
    assert!(is_write_class_tool("browser_evaluation_write"));
}

#[test]
fn advertised_host_catalog_excludes_verbose_browser_compatibility_aliases() {
    let advertised = advertised_tool_specs();
    let searchable = tool_specs();
    let advertised_bytes = serde_json::to_vec(&advertised).unwrap().len();
    let searchable_bytes = serde_json::to_vec(&searchable).unwrap().len();
    eprintln!(
        "Host tool catalog: advertised={} tools/{} bytes, searchable={} tools/{} bytes",
        advertised.len(),
        advertised_bytes,
        searchable.len(),
        searchable_bytes
    );
    let advertised_names = advertised
        .iter()
        .filter_map(|spec| spec.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let searchable_names = searchable
        .iter()
        .filter_map(|spec| spec.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(advertised_names.len(), 6);
    for name in [
        "capabilities_summary",
        "search_tool",
        "host_read",
        "host_act",
        "browser_read",
        "browser_act",
    ] {
        assert!(
            advertised_names.contains(&name),
            "missing compact entry {name}"
        );
    }
    assert!(!advertised_names.contains(&"browser_observe"));
    assert!(searchable_names.contains(&"browser_observe"));
    assert!(!advertised_names.contains(&"vault_agent_request"));
    assert!(searchable_names.contains(&"vault_agent_request"));
    assert!(advertised_bytes + 100_000 < searchable_bytes);
    assert!(advertised_bytes <= 12_000);
    assert!(!is_write_class_tool("browser_read"));
    assert!(is_write_class_tool("browser_act"));
    assert!(!is_write_class_tool("host_read"));
    assert!(is_write_class_tool("host_act"));
}

#[test]
fn browser_observe_mcp_compacts_large_page_payloads_by_default() {
    let refs = (0..100)
        .map(|idx| json!({
            "refId": format!("dom-{idx}"),
            "role": "button",
            "label": format!("Button {idx} {}", "label".repeat(60)),
            "name": format!("Accessible button {idx}"),
            "selector": format!("#fixture-button-{idx}"),
            "fingerprint": format!("browser-fingerprint-{idx:04}"),
            "domPath": format!("html > body > main > section:nth-child({idx}) > button"),
            "locatorSuggestions": [
                { "kind": "role", "value": format!("button:Button {idx}"), "strict": true, "matchCount": 1 },
                { "kind": "css", "value": format!("#fixture-button-{idx}"), "strict": true, "matchCount": 1 }
            ],
            "bounds": { "x": idx, "y": idx * 2, "width": 120, "height": 32 },
            "visible": true,
            "enabled": true,
            "editable": false,
            "unused": null
        }))
        .collect::<Vec<_>>();
    let fields = (0..90)
        .map(|idx| json!({ "refId": format!("field-{idx}"), "label": format!("Field {idx}") }))
        .collect::<Vec<_>>();
    let groups = (0..70)
        .map(|idx| json!({ "groupId": format!("group-{idx}"), "groupKind": "profile" }))
        .collect::<Vec<_>>();
    let nodes = (0..140)
        .map(|idx| json!({ "refId": format!("node-{idx}"), "role": "option", "label": format!("Language {idx}") }))
        .collect::<Vec<_>>();
    let response = json!({
        "ok": true,
        "status": "applied",
        "observation": {
            "text": "x".repeat(8_000),
            "markdown": "m".repeat(9_000),
            "refs": refs,
            "formFields": fields,
            "formFieldGroups": groups,
            "accessibilityTree": nodes
        }
    });

    let compact = browser_compact_observe_result_for_mcp(response, &json!({}));
    let observation = compact
        .get("observation")
        .and_then(|value| value.as_object())
        .expect("compact response keeps observation");

    assert!(!observation["refs"].as_array().unwrap().is_empty());
    assert!(observation["refs"].as_array().unwrap().len() <= 32);
    assert!(observation["formFields"].as_array().unwrap().len() <= 16);
    assert!(observation["formFieldGroups"].as_array().unwrap().len() <= 16);
    assert!(observation["accessibilityTree"].as_array().unwrap().len() <= 24);
    assert_eq!(observation["refsTotal"].as_u64(), Some(100));
    assert_eq!(observation["formFieldsTotal"].as_u64(), Some(90));
    assert_eq!(observation["formFieldGroupsTotal"].as_u64(), Some(70));
    assert_eq!(observation["accessibilityTreeTotal"].as_u64(), Some(140));
    assert_eq!(observation["mcpCompacted"].as_bool(), Some(true));
    assert!(observation["text"].as_str().unwrap().len() < 8_000);
    assert!(observation["markdown"].as_str().unwrap().len() < 9_000);
    let structured_bytes = serde_json::to_vec(&compact).unwrap().len();
    assert!(
        structured_bytes <= browser_output::DEFAULT_OBSERVE_STRUCTURED_BYTES,
        "default observe structured response is {structured_bytes} bytes"
    );
    assert_eq!(
        observation["mcpBudgetBytes"].as_u64(),
        Some(browser_output::DEFAULT_OBSERVE_STRUCTURED_BYTES as u64)
    );
    assert_eq!(
        observation["mcpSerializedBytes"].as_u64(),
        Some(structured_bytes as u64)
    );
    assert_eq!(
        observation["mcpApproxTokens"].as_u64(),
        Some(structured_bytes.div_ceil(4) as u64)
    );

    let envelope = browser_mcp_result(
        browser_action_text_summary("observe", &compact),
        compact,
        false,
    );
    let envelope_bytes = serde_json::to_vec(&envelope).unwrap().len();
    assert!(
        envelope_bytes <= 4_000,
        "final MCP tool envelope is {envelope_bytes} bytes"
    );
}

#[test]
fn browser_observe_full_dump_requires_explicit_unbudgeted_opt_in() {
    let response = json!({
        "ok": true,
        "status": "applied",
        "observation": {
            "text": "x".repeat(8_000),
            "markdown": "m".repeat(9_000),
            "refs": [],
            "formFields": [],
            "formFieldGroups": [],
            "accessibilityTree": []
        }
    });
    let full = browser_compact_observe_result_for_mcp(
        response.clone(),
        &json!({ "fullObservation": true }),
    );
    assert_eq!(full, response);
    assert!(serde_json::to_vec(&full).unwrap().len() > 17_000);
}

#[test]
fn browser_quiet_check_path_is_bounded_and_encodes_existing_targets() {
    assert!(!is_write_class_tool("browser_check"));
    assert_eq!(
        browser_quiet_check_path(
            &json!({
                "taskId": "browser-task/one",
                "browserTabId": "browser tab one",
            }),
            240_000,
        ),
        "/browser/check?timeoutMs=120000&taskId=browser-task%2Fone&browserTabId=browser%20tab%20one"
    );
    assert_eq!(
        browser_quiet_check_path(&json!({}), 0),
        "/browser/check?timeoutMs=0"
    );
}

#[test]
fn browser_rendered_check_body_is_bounded_and_read_class() {
    assert!(!is_write_class_tool("browser_rendered_check"));
    let body = browser_state::browser_rendered_check_body(&json!({
        "url": "http://127.0.0.1:3000/",
        "expect_text": "Ready",
        "selector": "#ready",
        "timeout_ms": 90_000,
        "settle_ms": 9_000,
        "expected_domains": ["127.0.0.1"],
    }))
    .expect("rendered check body");
    assert_eq!(body["expectText"], json!("Ready"));
    assert_eq!(body["timeoutMs"], json!(30_000));
    assert_eq!(body["settleMs"], json!(2_000));
    assert_eq!(body["expectedDomains"], json!(["127.0.0.1"]));
}

#[test]
fn browser_action_text_summary_surfaces_agent_evidence_fields() {
    let observe = browser_action_text_summary(
        "observe",
        &json!({
            "ok": true,
            "status": "applied",
            "taskId": "browser-task-1",
            "currentUrl": "https://example.com/",
            "observation": {
                "snapshotId": "browser-snapshot-1234567890abcdef",
                "title": "Example Domain",
                "refs": [{ "refId": "page" }],
                "refsTotal": 12,
                "formFields": [],
                "formFieldGroups": [{ "groupId": "login", "groupKind": "login" }],
                "formFieldGroupsTotal": 1,
                "accessibilityTree": [{ "role": "document" }],
                "accessibilityTreeTotal": 3,
                "delta": {
                    "fromSnapshotId": "browser-snapshot-0000000000000000",
                    "changed": true,
                    "urlChanged": false,
                    "titleChanged": false,
                    "textChanged": true,
                    "structureChanged": true,
                    "addedRefCount": 2,
                    "removedRefCount": 1,
                    "updatedRefCount": 3,
                    "truncated": false
                }
            }
        }),
    );
    assert!(observe.contains("snapshotId=browser-snapshot-1234567890abcdef"));
    assert!(observe.contains("title=\"Example Domain\""));
    assert!(observe.contains("refs=1/12"));
    assert!(observe.contains("formGroups=1/1"));
    assert!(observe.contains("changed=true"));
    assert!(observe.contains("refDelta=+2/-1/~3"));
    assert!(observe.contains("changeKinds=text,structure"));

    let screenshot = browser_action_text_summary(
        "captureScreenshot",
        &json!({
            "ok": true,
            "status": "applied",
            "screenshot": {
                "path": "C:\\Users\\FixtureUser\\.grok\\shellx-browser-screenshots\\shellx-browser-test.png",
                "fullPage": true,
                "width": 1380,
                "height": 1152,
                "pageWidth": 920,
                "pageHeight": 768,
                "bytes": 26100,
                "sha256": "7ed5216a000000000000000000000000000000000000000000000000752f9dc1"
            }
        }),
    );
    assert!(screenshot.contains("screenshotPath="));
    assert!(screenshot.contains("shellx-browser-test.png"));
    assert!(screenshot.contains("fullPage=true"));
    assert!(screenshot.contains("size=1380x1152"));
    assert!(screenshot.contains("pageSize=920x768"));
    assert!(screenshot.contains("cssScale=1.50x1.50"));

    let blocked = browser_action_text_summary(
        "clickRef",
        &json!({
            "ok": false,
            "status": "notActionable",
            "actionability": {
                "failedChecks": ["receivesEvents"],
                "coveringElement": { "selector": "#cover-layer" }
            },
            "stepSummary": {
                "snapshotId": "browser-snapshot-deadbeefdeadbeef",
                "targetSelector": "#covered-action",
                "locatorCandidates": [{ "refId": "dom-2" }]
            },
            "mcpRecovery": {
                "attempted": true,
                "strategy": "forceClick",
                "ok": true
            }
        }),
    );
    assert!(blocked.contains("failedChecks=receivesEvents"));
    assert!(blocked.contains("coveringElement=\"#cover-layer\""));
    assert!(blocked.contains("locatorCandidates=1"));
    assert!(blocked.contains("mcpRecovery=forceClick:ok=true"));
}

#[test]
fn browser_run_steps_result_entry_carries_recovery_evidence() {
    let data = json!({
        "taskId": "task-1",
        "currentUrl": "https://example.test/",
        "mcpRecovery": {
            "attempted": true,
            "strategy": "strictLocator",
            "ok": true
        }
    });

    let entry = browser_run_steps_result_entry(
        2,
        "clickRef",
        true,
        "applied",
        "browser clickRef: status=applied; mcpRecovery=strictLocator:ok=true".to_string(),
        &data,
    );

    assert_eq!(entry["index"], json!(2));
    assert_eq!(entry["action"], json!("clickRef"));
    assert_eq!(entry["mcpRecovery"]["strategy"], json!("strictLocator"));
    assert_eq!(entry["mcpRecovery"]["ok"], json!(true));
}

#[test]
fn browser_run_steps_aggregate_keeps_continued_failures_visible() {
    let results = vec![
        browser_run_steps_failure_entry(
            0,
            Some("unsupportedAction"),
            "rejected",
            "validation",
            "unsupported Browser action".to_string(),
        ),
        browser_run_steps_result_entry(
            1,
            "observe",
            true,
            "applied",
            "browser observe: status=applied".to_string(),
            &json!({ "taskId": "task-1" }),
        ),
    ];

    let aggregate = browser_run_steps_aggregate(&results);
    assert_eq!(aggregate.succeeded, 1);
    assert_eq!(aggregate.failed, 1);
    assert!(aggregate.continued_after_failure);
    assert_eq!(aggregate.failures[0]["index"], json!(0));
    assert_eq!(aggregate.failures[0]["failureKind"], json!("validation"));
}

#[test]
fn browser_run_steps_aggregate_does_not_confuse_last_step_failure_with_early_stop() {
    let results = vec![
        browser_run_steps_result_entry(
            0,
            "observe",
            true,
            "applied",
            "browser observe: status=applied".to_string(),
            &json!({}),
        ),
        browser_run_steps_result_entry(
            1,
            "verify",
            false,
            "verificationFailed",
            "browser verify: status=verificationFailed".to_string(),
            &json!({ "message": "expected text was absent" }),
        ),
    ];

    let aggregate = browser_run_steps_aggregate(&results);
    assert_eq!(aggregate.succeeded, 1);
    assert_eq!(aggregate.failed, 1);
    assert!(!aggregate.continued_after_failure);
    assert_eq!(aggregate.failures[0]["failureKind"], json!("action"));
    assert_eq!(
        aggregate.failures[0]["error"],
        json!("expected text was absent")
    );
}

#[tokio::test]
async fn browser_run_steps_tool_continues_validation_failures_without_false_success() {
    let result = tool_browser_run_steps(
        json!({
            "continueOnError": true,
            "steps": [
                { "action": "unsupportedContractProbe" },
                { "action": "fillFromVaultGrant" }
            ]
        }),
        None,
    )
    .await
    .expect("validation failures are returned as structured batch results");
    let structured = &result["structuredContent"];

    assert_eq!(result["isError"], json!(true));
    assert_eq!(structured["ok"], json!(false));
    assert_eq!(structured["stepsPlanned"], json!(2));
    assert_eq!(structured["stepsRun"], json!(2));
    assert_eq!(structured["stepsSucceeded"], json!(0));
    assert_eq!(structured["stepsFailed"], json!(2));
    assert_eq!(structured["continuedAfterFailure"], json!(true));
    assert_eq!(structured["stoppedAt"], Value::Null);
    assert_eq!(
        structured["failureSummary"][1]["failureKind"],
        json!("validation")
    );
}

#[tokio::test]
async fn browser_run_steps_tool_stops_at_first_failure_by_default() {
    let result = tool_browser_run_steps(
        json!({
            "steps": [
                { "action": "unsupportedContractProbe" },
                { "action": "fillFromVaultGrant" }
            ]
        }),
        None,
    )
    .await
    .expect("validation failure is returned as a structured batch result");
    let structured = &result["structuredContent"];

    assert_eq!(result["isError"], json!(true));
    assert_eq!(structured["stepsRun"], json!(1));
    assert_eq!(structured["stepsFailed"], json!(1));
    assert_eq!(structured["continuedAfterFailure"], json!(false));
    assert_eq!(structured["stoppedAt"], json!(0));
}

#[tokio::test]
async fn browser_run_steps_tool_rejects_empty_and_oversized_batches() {
    let empty = tool_browser_run_steps(json!({ "steps": [] }), None)
        .await
        .expect_err("empty batches are rejected");
    assert!(empty.contains("at least one step"));

    let oversized_steps = vec![json!({ "action": "observe" }); 21];
    let oversized = tool_browser_run_steps(json!({ "steps": oversized_steps }), None)
        .await
        .expect_err("oversized batches are rejected");
    assert!(oversized.contains("at most 20 steps"));
}

#[test]
fn browser_action_body_rejects_taskless_browser_tab_targeting() {
    let err = browser_action_body(
        "observe",
        json!({
            "browserTabId": "browser-tab-personal"
        }),
    )
    .expect_err("agent MCP calls must not target a tab without task context");
    assert!(err.contains("browserTabId must also pass the owning taskId"));
}

#[test]
fn browser_click_and_fill_ref_accept_selector_targets() {
    let click = browser_action_body(
        "clickRef",
        json!({
            "taskId": "task-1",
            "selector": "[data-testid=submit]"
        }),
    )
    .expect("selector click target parses");
    assert_eq!(click["action"], json!("clickRef"));
    assert_eq!(click["selector"], json!("[data-testid=submit]"));

    let fill = browser_action_body(
        "fillRef",
        json!({
            "taskId": "task-1",
            "selector": "[data-testid=email]",
            "value": "agent@example.com"
        }),
    )
    .expect("selector fill target parses");
    assert_eq!(fill["action"], json!("fillRef"));
    assert_eq!(fill["selector"], json!("[data-testid=email]"));
    assert_eq!(fill["value"], json!("agent@example.com"));

    let err = browser_action_body(
        "clickRef",
        json!({
            "taskId": "task-1"
        }),
    )
    .expect_err("click still requires a concrete target");
    assert!(err.contains("refId or selector"));
}

#[test]
fn browser_mcp_navigation_settle_uses_compact_server_endpoint() {
    let response = json!({
        "ok": true,
        "status": "applied",
        "taskId": "task-1",
        "browserTabId": "tab-1"
    });
    assert!(browser_mcp_navigation_response_should_wait(
        "navigate", &response
    ));
    assert_eq!(
        browser_state::browser_mcp_settle_path(&response, 10_000),
        "/browser/settle?taskId=task-1&browserTabId=tab-1&timeoutMs=10000"
    );
    assert!(!browser_mcp_navigation_response_should_wait(
        "observe", &response
    ));
}

#[test]
fn browser_mcp_history_and_reload_actions_wait_for_settle() {
    let response = json!({
        "ok": true,
        "status": "applied"
    });
    for action in ["goBack", "goForward", "reload"] {
        assert!(
            browser_mcp_navigation_response_should_wait(action, &response),
            "{action} should wait for Browser engine settle before the next batched action"
        );
    }
}

#[test]
fn browser_run_steps_normalizes_only_generic_actions() {
    assert_eq!(
        browser_run_steps_allowed_action("navigate").expect("navigate allowed"),
        "navigate"
    );
    assert_eq!(
        browser_run_steps_allowed_action("pressKey").expect("pressKey aliases to press"),
        "press"
    );
    assert_eq!(
        browser_run_steps_allowed_action("captureScreenshot")
            .expect("screenshots are generic evidence"),
        "captureScreenshot"
    );
    assert_eq!(
        browser_run_steps_allowed_action("findText").expect("text search is generic"),
        "findText"
    );
    assert_eq!(
        browser_run_steps_allowed_action("extractTable").expect("table extraction is generic"),
        "extractTable"
    );
    assert_eq!(
        browser_run_steps_allowed_action("scroll").expect("scroll is generic"),
        "scroll"
    );
    assert_eq!(
        browser_run_steps_allowed_action("select").expect("select is generic"),
        "select"
    );
    assert_eq!(
        browser_run_steps_allowed_action("back").expect("back aliases to goBack"),
        "goBack"
    );
    assert_eq!(
        browser_run_steps_allowed_action("goForward").expect("forward is generic"),
        "goForward"
    );
    assert_eq!(
        browser_run_steps_allowed_action("reload").expect("reload is generic"),
        "reload"
    );
    let sensitive = browser_run_steps_allowed_action("fillFromVaultGrant")
        .expect_err("Vault fills stay explicit gated calls");
    assert!(
        sensitive.contains("unsupported sensitive Browser action")
            && sensitive.contains("dedicated gated MCP tool")
    );
    let unsupported = browser_run_steps_allowed_action("openGoogleAiStudioApiKey")
        .expect_err("site-specific action aliases are not allowed");
    assert!(unsupported.contains("unsupported Browser action"));
}

#[test]
fn browser_run_steps_merges_common_context_without_site_logic() {
    let (action, step_args) = browser_run_steps_step_args(
        &json!({
            "taskId": "task-1",
            "lockLeaseId": "lease-1",
            "timeoutMs": 12000
        }),
        &json!({
            "action": "pressKey",
            "key": "Enter"
        }),
    )
    .expect("step args");
    assert_eq!(action, "press");
    assert_eq!(step_args["action"], json!("press"));
    assert_eq!(step_args["taskId"], json!("task-1"));
    assert_eq!(step_args["lockLeaseId"], json!("lease-1"));
    assert_eq!(step_args["timeoutMs"], json!(12000));
    assert_eq!(step_args["key"], json!("Enter"));

    let body = browser_action_body(&action, step_args).expect("press body");
    assert_eq!(body["action"], json!("press"));
    assert_eq!(body["taskId"], json!("task-1"));
    assert_eq!(body["key"], json!("Enter"));
}

#[test]
fn browser_run_steps_maps_find_text_query_to_browser_value() {
    let (action, step_args) = browser_run_steps_step_args(
        &json!({ "taskId": "task-1" }),
        &json!({
            "action": "findText",
            "query": "Billing settings"
        }),
    )
    .expect("findText step args");
    assert_eq!(action, "findText");
    assert_eq!(step_args["value"], json!("Billing settings"));
    assert!(
        step_args.get("query").is_none(),
        "query is an MCP convenience alias and should not be forwarded to /browser/action"
    );
}

#[test]
fn vault_grant_tools_are_discoverable_and_pending_only() {
    let specs = tool_specs();
    let request = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vault_request_grant"))
        .expect("vault_request_grant tool present");
    let list = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vault_list_grants"))
        .expect("vault_list_grants tool present");
    let request_desc = request["description"].as_str().unwrap_or_default();
    assert!(request_desc.contains("pending"));
    assert!(request_desc.contains("cannot approve"));
    assert!(request_desc.contains("RawReveal"));
    assert!(list["description"]
        .as_str()
        .unwrap_or_default()
        .contains("never returns secret values"));
    assert!(is_write_class_tool("vault_request_grant"));
    assert!(!is_write_class_tool("vault_list_grants"));
}

#[test]
fn vault_agent_request_is_operator_mediated_and_desktop_scoped() {
    let specs = tool_specs();
    let request = specs
        .iter()
        .find(|spec| spec.get("name").and_then(Value::as_str) == Some("vault_agent_request"))
        .expect("vault_agent_request tool present");
    let description = request["description"].as_str().unwrap_or_default();
    assert!(description.contains("never approves"));
    assert!(description.contains("ShellX desktop host"));
    assert!(description.contains("not the active SSH/WSL target"));
    assert!(is_write_class_tool("vault_agent_request"));
    assert!(tool_capabilities_summary_test_fixture_mentions_vault_agent_request());
}

fn tool_capabilities_summary_test_fixture_mentions_vault_agent_request() -> bool {
    include_str!("../host_state_tools.rs").contains("vault_agent_request")
}

#[test]
fn vault_agent_request_body_forces_mediated_value_bindings() {
    let body = vault_agent_request_body(
        &json!({
            "action": "request",
            "actorLabel": "Codex",
            "purpose": "Publish with the approved token",
            "program": "/usr/bin/npm",
            "args": ["publish", "--dry-run"],
            "cwd": "/workspace/package",
            "bindings": [{
                "secretRef": "vault:npm/token",
                "env": "NODE_AUTH_TOKEN",
                "field": "raw"
            }],
            "timeoutMs": 120000
        }),
        &vault_agent_actor_id(Some("tab-1")),
    )
    .expect("agent request body");
    assert_eq!(body["actorId"], json!(vault_agent_actor_id(Some("tab-1"))));
    assert_eq!(body["spec"]["program"], json!("/usr/bin/npm"));
    assert_eq!(
        body["spec"]["bindings"][0]["resourceId"],
        json!("npm/token")
    );
    assert_eq!(body["spec"]["bindings"][0]["field"], json!("value"));
    assert_eq!(body["spec"]["bindings"][0]["env"], json!("NODE_AUTH_TOKEN"));

    let legacy = vault_agent_request_body(
        &json!({
            "purpose": "legacy",
            "program": "/usr/bin/env",
            "bindings": [{ "resourceId": "pass:token", "env": "TOKEN" }]
        }),
        &vault_agent_actor_id(Some("tab-1")),
    )
    .expect_err("legacy pass binding must be refused");
    assert!(legacy.contains("pass-store"));
}

#[test]
fn vault_agent_actor_identity_is_bound_to_the_host_session() {
    let first = vault_agent_actor_id(Some("tab-42"));
    assert!(first.starts_with("shellx-agent-session:"));
    assert_eq!(first, vault_agent_actor_id(Some("tab-42")));
    assert_ne!(first, vault_agent_actor_id(Some("tab-43")));
    assert_eq!(vault_agent_actor_id(None), "shellx-agent-session:default");
}

#[test]
fn vault_grant_request_body_preserves_debug_api_contract() {
    let body = vault_grant_request_body(json!({
        "secretRef": "accounts/example-password",
        "operation": "email_code_read",
        "actorKind": "browserOrigin",
        "origin": "https://accounts.google.com",
        "expiresAtMs": 1_790_000_000_000u64
    }))
    .expect("grant body");
    assert_eq!(body["secretRef"], json!("accounts/example-password"));
    assert_eq!(body["operation"], json!("emailCodeRead"));
    assert_eq!(body["actorScope"]["kind"], json!("browserOrigin"));
    assert_eq!(
        body["actorScope"]["origin"],
        json!("https://accounts.google.com")
    );
    assert_eq!(body["origin"], json!("https://accounts.google.com"));
    assert_eq!(body["expiresAtMs"], json!(1_790_000_000_000i64));

    let missing_origin = vault_grant_request_body(json!({
        "secretRef": "accounts/example-password",
        "operation": "fill"
    }))
    .expect_err("browser grants must be explicitly origin-bound");
    assert!(missing_origin.contains("require origin"));

    let raw = vault_grant_request_body(json!({
        "secretRef": "token",
        "operation": "rawReveal"
    }))
    .expect_err("raw reveal must not be requestable through MCP");
    assert!(raw.contains("rawReveal"));
}

#[test]
fn vision_tool_catalog_advertises_single_oauth_first_tool() {
    let specs = tool_specs();
    let names: Vec<&str> = specs
        .iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
        .collect();
    assert!(names.contains(&"vision_describe"));
    assert!(
        !names.contains(&"vision_describe_v2"),
        "v2 compatibility alias must stay hidden from tools/list"
    );

    let vision = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vision_describe"))
        .expect("vision_describe tool present");
    let desc = vision["description"].as_str().unwrap_or_default();
    assert!(
        desc.contains("OAuth") && desc.contains("~/.grok/auth.json"),
        "vision_describe description should steer Grok to OAuth-first auth: {desc}"
    );
    assert!(
        desc.contains("vault:xai/api-key") && desc.contains("XAI_API_KEY"),
        "vision_describe description should still document fallback auth paths: {desc}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn stdio_dispatch_rejects_write_class_tools_without_embedded_permission_gate() {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    for (id, name, arguments) in [
        (
            1,
            "fs_ensure_dir",
            json!({ "path": "/tmp/shellx-stdio-gate-regression" }),
        ),
        (2, "build_checkpoint", json!({ "label": "audit gate" })),
        (3, "build_complete", json!({ "summary": "audit gate" })),
        (4, "security_scan", json!({ "run_audits": true })),
        (5, "preview_start", json!({ "cwd": "/tmp" })),
        (6, "browser_click_ref", json!({ "refId": "ref-1" })),
        (
            7,
            "browser_fill_ref",
            json!({ "refId": "ref-1", "value": "text" }),
        ),
        (8, "browser_save_page", json!({ "taskId": "task-1" })),
        (9, "browser_trace_open", json!({ "taskId": "task-1" })),
        (13, "browser_screenshot", json!({ "taskId": "task-1" })),
        (
            14,
            "browser_flight_recorder_export",
            json!({ "taskId": "task-1" }),
        ),
        (
            10,
            "browser_run_steps",
            json!({ "steps": [{ "action": "waitFor", "value": "Ready" }] }),
        ),
        (
            11,
            "browser_act",
            json!({ "action": "navigate", "url": "https://example.com" }),
        ),
        (
            12,
            "host_act",
            json!({ "action": "fs_write", "params": { "path": "/tmp/shellx-stdio-gate-regression", "content": "blocked" } }),
        ),
    ] {
        let req = JsonRpcReq {
            id: Some(json!(id)),
            method: Some("tools/call".to_string()),
            params: Some(json!({
                "name": name,
                "arguments": arguments
            })),
        };

        let response = dispatch_to_value(req, &ctx)
            .await
            .expect("JSON-RPC calls with ids must return responses");
        assert_eq!(response["error"]["code"], json!(-32603));
        let message = response["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("stdio standalone") && message.contains("write-class"),
            "unexpected gate error for {}: {}",
            name,
            message
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn host_read_dispatches_to_the_existing_handler_without_double_wrapping() {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    let req = JsonRpcReq {
        id: Some(json!("host-read-clock")),
        method: Some("tools/call".to_string()),
        params: Some(json!({
            "name": "host_read",
            "arguments": {
                "action": "clock_now",
                "params": { "tz": "utc" }
            }
        })),
    };
    let response = dispatch_to_value(req, &ctx)
        .await
        .expect("JSON-RPC calls with ids must return responses");
    assert!(
        response.get("error").is_none(),
        "unexpected error: {response}"
    );
    assert_eq!(
        response["result"]["structuredContent"]["tz_used"],
        json!("utc")
    );
    assert!(response["result"]["structuredContent"]["unix_ms"]
        .as_u64()
        .is_some());
}
