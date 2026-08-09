use super::super::*;

#[test]
fn initialize_exposes_browser_contract_and_build_identity() {
    let response = handle_initialize(&json!({
        "protocolVersion": "2025-06-18"
    }));
    let server = response.get("serverInfo").expect("initialize serverInfo");
    assert_eq!(
        server.get("browserProtocolVersion").and_then(Value::as_str),
        Some(crate::build_metadata::BROWSER_PROTOCOL_VERSION)
    );
    assert_eq!(
        server.get("browserSchemaRevision").and_then(Value::as_str),
        Some(crate::build_metadata::BROWSER_SCHEMA_REVISION)
    );
    assert_eq!(
        server.get("buildCommit").and_then(Value::as_str),
        Some(crate::build_metadata::SHELLX_BUILD_COMMIT)
    );
    assert!(server
        .get("browserFeatureFlags")
        .and_then(Value::as_array)
        .is_some_and(|flags| !flags.is_empty()));
}

#[test]
fn credential_pattern_redacts_vendor_prefixes_and_high_entropy_tokens() {
    let slack_like = ["xox", "b-123456789012-ABCDEFGHIJKLMNO"].concat();
    let samples = [
        slack_like.as_str(),
        "glpat-1234567890abcdef",
        "fc-4e324f02a08c4bb9a9cbb3a955bf8592",
        "AIzaSyB1234567890abcdef",
        "SG.abcdefghi.1234567890abcdef",
        "token qwertyuiopasdfghjklzxcvbnm",
    ];
    for sample in samples {
        assert!(
            redact_if_credential_pattern(sample),
            "expected credential-shaped sample to redact: {sample}"
        );
    }
    assert!(
        !redact_if_credential_pattern("ThisIsALongCamelCaseIdentifierName"),
        "ordinary CamelCase identifiers should stay readable"
    );
    assert!(
        !redact_if_credential_pattern("browser-task-a5e9743d-0697-4873-8f27-12a6843d9f69"),
        "task identifiers containing an embedded sk- sequence should stay readable"
    );
    assert!(
        redact_if_credential_pattern("token=sk-abcdefghijklmnopqrstuvwxyz1234567890"),
        "a delimited OpenAI-style key prefix should still redact"
    );
}

#[test]
fn provider_state_paths_encode_transport_context() {
    assert_eq!(
        provider_state_path("/provider-adapters/state", None, None, None, None, None),
        "/provider-adapters/state"
    );
    assert_eq!(
        provider_state_path(
            "/provider-adapters/state",
            Some("wsl"),
            Some("Ubuntu 24.04"),
            None,
            None,
            None,
        ),
        "/provider-adapters/state?transport=wsl&wslDistro=Ubuntu%2024.04"
    );
    assert_eq!(
        provider_sessions_state_path("tab/a", Some("wsl"), Some("Ubuntu-24.04"), None, None, None),
        "/provider-sessions/state?tabId=tab%2Fa&transport=wsl&wslDistro=Ubuntu-24.04"
    );
    assert_eq!(
        provider_sessions_state_path(
            "tab/a",
            Some("ssh"),
            None,
            Some("fixture-host"),
            Some(2222),
            Some("connections/ssh key"),
        ),
        "/provider-sessions/state?tabId=tab%2Fa&transport=ssh&sshHost=fixture-host&sshPort=2222&sshKeyVaultRef=connections%2Fssh%20key"
    );
    assert_eq!(
        provider_state_path(
            "/provider-adapters/state",
            Some("ssh"),
            None,
            Some("fixture-host"),
            Some(2222),
            Some("connections/ssh key"),
        ),
        "/provider-adapters/state?transport=ssh&sshHost=fixture-host&sshPort=2222&sshKeyVaultRef=connections%2Fssh%20key"
    );
}

#[test]
fn credential_pattern_leaves_protocol_and_tool_identifiers_readable() {
    let samples = [
        "session/update",
        "available_commands_update",
        "tool_call_delta_chunk",
        "run_terminal_command",
        "shellx-host-http__Agent",
        "grok-shell-host__build_receipt",
        "shellx-mp-git__git_diff",
        "fs_list_dir",
        "desktop_mouse_drag",
        "services/shellxTransport.ts",
        "store/consoleStore.ts",
        "app/(tabs)/index.tsx",
        "/home/alice/shellx-surface-console-prototype",
    ];
    for sample in samples {
        assert!(
            !redact_if_credential_pattern(sample),
            "protocol/tool identifier should stay readable: {sample}"
        );
    }
}

#[test]
fn build_agent_task_preview_redacts_credential_shaped_text() {
    let preview = redacted_task_preview(
        "review this curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.payload'", // gitleaks:allow -- synthetic redaction vector
        180,
    );

    assert_eq!(preview, "<redacted: credential-shaped substring>");
    assert_eq!(
        redacted_task_preview("review the login form wiring", 180),
        "review the login form wiring"
    );
    assert_eq!(
        redacted_task_preview(
            "Review the ShellX Surface Console Expo app at /home/alice/shellx-surface-console-prototype. Run `git diff` and read services/shellxTransport.ts, store/consoleStore.ts, and app/(tabs)/index.tsx.",
            220,
        ),
        "Review the ShellX Surface Console Expo app at /home/alice/shellx-surface-console-prototype. Run `git diff` and read services/shellxTransport.ts, store/consoleStore.ts, and app/(tabs)/index.tsx."
    );
}

#[test]
fn build_gate_agent_task_adds_output_contract_only_for_gate_personas() {
    let review_task = build_gate_agent_task("reviewer", "review the diff");
    assert!(review_task.contains("shellX Build gate output requirements"));
    assert!(review_task.contains("`## Review`"));

    let review_task_again = build_gate_agent_task("reviewer", &review_task);
    assert_eq!(
        review_task
            .matches("shellX Build gate output requirements")
            .count(),
        review_task_again
            .matches("shellX Build gate output requirements")
            .count()
    );

    assert_eq!(
        build_gate_agent_task("implementer", "fix the bug"),
        "fix the bug"
    );
}

#[test]
fn build_gate_output_evidence_rejects_ok_only_and_accepts_reports() {
    let weak = build_gate_output_evidence("reviewer", "OK");
    assert_eq!(weak["accepted"], json!(false));
    assert_eq!(weak["reason"], json!("gate output too short"));

    let review = build_gate_output_evidence(
        "reviewer",
        "## Review: scope\n\n### Summary\n0 critical, 0 major, 0 minor findings. The changed files are limited to the expected review scope.\n\n### Positive observations\n- No new issues found.",
    );
    assert_eq!(review["accepted"], json!(true));

    let verify = build_gate_output_evidence(
        "verifier",
        "## Verification\n- `cargo test build_complete` - PASS\n\n## Behavior Evidence\n- exercised the build completion gate with weak and strong receipts.\n\n## Gaps\n- none.",
    );
    assert_eq!(verify["accepted"], json!(true));
}

#[test]
fn non_git_agent_fallback_only_marks_real_code_change_personas_or_test_files() {
    assert!(build_agent_checkpoint_fallback_assume_code_change(
        "implementer",
        "Create index.html"
    ));
    assert!(build_agent_checkpoint_fallback_assume_code_change(
        "release-manager",
        "Package the release artifacts"
    ));
    assert!(!build_agent_checkpoint_fallback_assume_code_change(
        "reviewer",
        "Review index.html"
    ));
    assert!(!build_agent_checkpoint_fallback_assume_code_change(
        "test-writer",
        "For the static index.html with inline JS button behavior, design meaningful verification steps or test cases that can be used to confirm the result."
    ));
    assert!(!build_agent_checkpoint_fallback_assume_code_change(
        "test-writer",
        "Without modifying files, write manual test cases for the delivered page."
    ));
    assert!(build_agent_checkpoint_fallback_assume_code_change(
        "test-writer",
        "Write a test file at src/button.test.ts for the click behavior."
    ));
    assert!(build_agent_checkpoint_fallback_assume_code_change(
        "test-writer",
        "Add tests to tests/button.spec.ts."
    ));
}

#[test]
fn tool_specs_well_formed() {
    let specs = tool_specs();
    let names: Vec<&str> = specs
        .iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
        .collect();
    for required in [
        "shellx_health",
        "model_instruction_cards",
        "provider_adapters",
        "provider_sessions",
        "session_tooling",
        "environment",
        "grok_environment",
        "event_log",
        "fs_watch",
        "fs_unwatch",
        "process_list",
        "process_signal",
        "process_stats",
        "process_attach_stdout",
        "secret_get",
        "vault_list",
        "vault_list_grants",
        "vault_request_grant",
        "vault_agent_request",
        // Agent family.
        "Agent",
        "Agent_status",
        "Agent_output",
        "build_checkpoint",
        "build_state",
        "build_receipts",
        // Kill + metrics.
        "Agent_kill",
        "Agent_metrics",
        "preview_state",
        "preview_logs",
        "preview_start",
        "preview_diagnose",
        "browser_read",
        "browser_act",
        "browser_state",
        "browser_tabs",
        "browser_locks",
        "browser_navigate",
        "browser_observe",
        "browser_click_ref",
        "browser_click_at",
        "browser_fill_ref",
        "browser_type_text",
        "browser_clear_site_data",
        "browser_run_steps",
        "browser_workflows",
        "browser_workflow_save",
        "browser_workflow_replay",
        "browser_fill_from_vault",
        "browser_fill_profile_card",
        "browser_capture_secret_to_vault",
        "browser_read_email_code",
        "browser_use_agent_wallet",
        "browser_wait_for",
        "browser_extract",
        "browser_save_page",
        "browser_verify",
        "browser_screenshot",
        "browser_downloads",
        "browser_resolve_dialog",
        "browser_trace_open",
    ] {
        assert!(names.contains(&required), "missing tool: {}", required);
    }
    // every tool must have an inputSchema object
    for spec in &specs {
        assert!(spec.get("inputSchema").is_some());
        assert_eq!(
            spec["inputSchema"]["type"],
            Value::String("object".to_string())
        );
    }
}

#[test]
fn security_scan_tool_is_registered() {
    let specs = tool_specs();
    let names: Vec<&str> = specs
        .iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
        .collect();
    assert!(
        names.contains(&"security_scan"),
        "missing security_scan tool"
    );
}

#[test]
fn browser_mcp_tools_are_debug_api_wrappers() {
    let specs = tool_specs();
    let names: Vec<&str> = specs
        .iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
        .collect();
    let browser_tools = [
        "browser_state",
        "browser_tabs",
        "browser_locks",
        "browser_navigate",
        "browser_observe",
        "browser_click_ref",
        "browser_fill_ref",
        "browser_run_steps",
        "browser_workflows",
        "browser_workflow_save",
        "browser_workflow_replay",
        "browser_fill_from_vault",
        "browser_fill_profile_card",
        "browser_capture_secret_to_vault",
        "browser_read_email_code",
        "browser_use_agent_wallet",
        "browser_wait_for",
        "browser_extract",
        "browser_save_page",
        "browser_verify",
        "browser_screenshot",
        "browser_downloads",
        "browser_resolve_dialog",
        "browser_trace_open",
    ];
    for required in browser_tools {
        assert!(
            names.contains(&required),
            "missing Browser MCP tool: {required}"
        );
    }
    for required in [
        "browser_state",
        "browser_tabs",
        "browser_locks",
        "browser_navigate",
        "browser_observe",
        "browser_click_ref",
        "browser_fill_ref",
        "browser_fill_from_vault",
        "browser_run_steps",
        "browser_wait_for",
        "browser_extract",
        "browser_verify",
        "browser_trace_open",
    ] {
        let desc = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some(required))
            .and_then(|s| s.get("description"))
            .and_then(|d| d.as_str())
            .unwrap_or_default();
        for term in [
            "native ShellX Browser",
            "browser_navigate",
            "browser_observe",
        ] {
            assert!(
                desc.contains(term),
                "{required} description must expose Browser navigation flow term {term}: {desc}"
            );
        }
    }

    let navigate = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_navigate"))
        .expect("browser_navigate tool present");
    assert!(
        navigate["description"]
            .as_str()
            .unwrap_or_default()
            .contains("native ShellX Browser"),
        "browser_navigate must teach agents that the native Browser exists"
    );
    assert!(
        navigate["description"]
            .as_str()
            .unwrap_or_default()
            .contains("task-disposable task bound to this MCP caller"),
        "browser_navigate must teach agents that taskless calls use caller-bound disposable tasks"
    );
    assert!(
        navigate["inputSchema"]["required"]
            .as_array()
            .is_some_and(|required| required.contains(&Value::String("url".to_string()))),
        "browser_navigate must require url"
    );

    let state = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_state"))
        .expect("browser_state tool present");
    assert!(
        state["description"]
            .as_str()
            .unwrap_or_default()
            .contains("Do not save raw state JSON to the current working directory"),
        "browser_state must direct agents away from raw working-folder dumps"
    );
    let quiet_check = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_check"))
        .expect("browser_check tool present");
    let quiet_description = quiet_check["description"].as_str().unwrap_or_default();
    for invariant in [
        "without starting a task",
        "opening or focusing the Browser window",
        "Use net_fetch",
        "visible native ShellX Browser",
    ] {
        assert!(
            quiet_description.contains(invariant),
            "browser_check must document quiet/cowork boundary {invariant}: {quiet_description}"
        );
    }
    assert_eq!(
        quiet_check["inputSchema"]["properties"]["timeoutMs"]["maximum"],
        json!(120_000),
        "browser_check settle wait must stay bounded"
    );
    let rendered_check = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_rendered_check"))
        .expect("browser_rendered_check tool present");
    let rendered_description = rendered_check["description"].as_str().unwrap_or_default();
    for invariant in [
        "incognito hidden renderer",
        "without opening/focusing the visible ShellX Browser",
        "using personal cookies",
        "visible native ShellX Browser",
    ] {
        assert!(
            rendered_description.contains(invariant),
            "browser_rendered_check must document hidden/cowork boundary {invariant}: {rendered_description}"
        );
    }
    assert_eq!(
        rendered_check["inputSchema"]["properties"]["timeoutMs"]["maximum"],
        json!(30_000),
        "browser_rendered_check timeout must stay bounded"
    );

    let observe = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_observe"))
        .expect("browser_observe tool present");
    assert!(
        observe["description"]
            .as_str()
            .unwrap_or_default()
            .contains("Do not write raw observation dumps to the current working directory"),
        "browser_observe must direct agents away from raw working-folder dumps"
    );
    assert!(
        observe["description"]
            .as_str()
            .unwrap_or_default()
            .contains("compact by default"),
        "browser_observe must teach agents that MCP observe output is compact"
    );
    assert!(
        observe["description"]
            .as_str()
            .unwrap_or_default()
            .contains("secret-*")
            && observe["description"]
                .as_str()
                .unwrap_or_default()
                .contains("capturePageSecretToVault"),
        "browser_observe must teach agents to use redacted capturable secret refs"
    );
    assert!(
        observe["inputSchema"]["properties"]
            .get("maxRefs")
            .is_some()
            && observe["inputSchema"]["properties"]
                .get("fullObservation")
                .is_some(),
        "browser_observe must expose compact-output controls"
    );

    let click = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_click_ref"))
        .expect("browser_click_ref tool present");
    assert!(
        click["description"]
            .as_str()
            .unwrap_or_default()
            .contains("Debug API"),
        "Browser MCP tools must be documented as Debug API wrappers"
    );
    assert!(
        click["inputSchema"]["properties"].get("refId").is_some(),
        "browser_click_ref must expose refId"
    );
    assert!(
        click["inputSchema"]["properties"].get("selector").is_some()
            && click["inputSchema"]["anyOf"]
                .as_array()
                .is_some_and(|any_of| {
                    any_of.iter().any(|branch| {
                        branch["required"]
                            .as_array()
                            .is_some_and(|required| required.contains(&json!("refId")))
                    }) && any_of.iter().any(|branch| {
                        branch["required"]
                            .as_array()
                            .is_some_and(|required| required.contains(&json!("selector")))
                    })
                }),
        "browser_click_ref must expose either refId or selector targeting"
    );
    assert!(
        click["inputSchema"]["properties"]
            .get("lockLeaseId")
            .is_some(),
        "browser_click_ref must pass Browser tab lock leases"
    );

    let fill = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_fill_ref"))
        .expect("browser_fill_ref tool present");
    assert!(
        fill["inputSchema"]["properties"].get("value").is_some(),
        "browser_fill_ref must expose value"
    );
    assert!(
        fill["inputSchema"]["properties"].get("selector").is_some()
            && fill["inputSchema"]["required"]
                .as_array()
                .is_some_and(|required| required.contains(&json!("value")))
            && fill["inputSchema"]["anyOf"]
                .as_array()
                .is_some_and(|any_of| {
                    any_of.iter().any(|branch| {
                        branch["required"]
                            .as_array()
                            .is_some_and(|required| required.contains(&json!("refId")))
                    }) && any_of.iter().any(|branch| {
                        branch["required"]
                            .as_array()
                            .is_some_and(|required| required.contains(&json!("selector")))
                    })
                }),
        "browser_fill_ref must expose value plus either refId or selector targeting"
    );

    let capture_secret = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_capture_secret_to_vault"))
        .expect("browser_capture_secret_to_vault tool present");
    let capture_desc = capture_secret["description"].as_str().unwrap_or_default();
    assert!(
        capture_desc.contains("secret-*")
            && capture_desc.contains("never the secret")
            && capture_desc.contains("does not click them or read the host clipboard"),
        "browser_capture_secret_to_vault must prefer redacted refs, promise no raw secret return, and document the fail-closed copy-only boundary"
    );

    let screenshot = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_screenshot"))
        .expect("browser_screenshot tool present");
    assert!(
        screenshot["description"]
            .as_str()
            .unwrap_or_default()
            .contains("fullPage=true"),
        "browser_screenshot must document full-page capture"
    );
    assert!(
        screenshot["inputSchema"]["properties"]
            .get("fullPage")
            .is_some(),
        "browser_screenshot must expose fullPage"
    );

    let save_page = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_save_page"))
        .expect("browser_save_page tool present");
    let save_desc = save_page["description"].as_str().unwrap_or_default();
    assert!(
        save_desc.contains("finalPath") && save_desc.contains("Downloads"),
        "browser_save_page must teach agents to use returned local paths: {save_desc}"
    );
    assert!(
        save_page["inputSchema"]["properties"]
            .get("destinationDir")
            .is_some(),
        "browser_save_page must expose destinationDir"
    );

    let run_steps = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_run_steps"))
        .expect("browser_run_steps tool present");
    let run_steps_desc = run_steps["description"].as_str().unwrap_or_default();
    assert!(
        run_steps_desc.contains("generic Browser action steps")
            && run_steps_desc.contains("not a site script runner")
            && run_steps_desc.contains("Browser/Vault/lock/dialog/actionability gates"),
        "browser_run_steps must describe generic batch control without site hardcoding: {run_steps_desc}"
    );
    assert!(
        run_steps["inputSchema"]["properties"]
            .get("steps")
            .is_some(),
        "browser_run_steps must expose steps"
    );
    assert!(
        is_write_class_tool("browser_run_steps"),
        "browser_run_steps mutates Browser state, so it must be write-class gated"
    );

    let downloads = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_downloads"))
        .expect("browser_downloads tool present");
    assert!(
        downloads["description"]
            .as_str()
            .unwrap_or_default()
            .contains("finalPath"),
        "browser_downloads must advertise completed transfer paths"
    );

    let resolve_dialog = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_resolve_dialog"))
        .expect("browser_resolve_dialog tool present");
    let resolve_desc = resolve_dialog["description"].as_str().unwrap_or_default();
    assert!(
        resolve_desc.contains("beforeunload") && resolve_desc.contains("non-personal"),
        "browser_resolve_dialog must describe its narrow beforeunload scope"
    );
    assert!(
        resolve_dialog["inputSchema"]["required"]
            .as_array()
            .is_some_and(
                |required| required.contains(&Value::String("dialogId".to_string()))
                    && required.contains(&Value::String("taskId".to_string()))
                    && required.contains(&Value::String("action".to_string()))
            ),
        "browser_resolve_dialog must require dialogId, taskId, and action"
    );

    let trace = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_trace_open"))
        .expect("browser_trace_open tool present");
    assert!(
        trace["description"].as_str().unwrap_or_default().contains(
            "Do not copy the trace or raw Browser state into the current working directory"
        ),
        "browser_trace_open must keep diagnostics in ShellX trace storage by default"
    );

    let workflows = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflows"))
        .expect("browser_workflows tool present");
    assert!(
        workflows["description"]
            .as_str()
            .unwrap_or_default()
            .contains("Agent workflow bookmarks"),
        "browser_workflows must expose reusable workflow discovery"
    );

    let workflow_save = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflow_save"))
        .expect("browser_workflow_save tool present");
    assert!(
        workflow_save["description"]
            .as_str()
            .unwrap_or_default()
            .contains("recipes/export")
            && workflow_save["description"]
                .as_str()
                .unwrap_or_default()
                .contains("agentWorkflow"),
        "browser_workflow_save must record recipe-backed workflow bookmarks"
    );
    assert!(
        is_write_class_tool("browser_workflow_save"),
        "workflow save writes a recipe artifact and bookmark, so it must be write-class gated"
    );

    let workflow_replay = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflow_replay"))
        .expect("browser_workflow_replay tool present");
    assert!(
        workflow_replay["description"]
            .as_str()
            .unwrap_or_default()
            .contains("dry-run by default"),
        "browser_workflow_replay must default to rehearsal before apply"
    );
    assert!(
        workflow_replay["description"]
            .as_str()
            .unwrap_or_default()
            .contains("decisionPoints"),
        "browser_workflow_replay must teach agents to inspect decision points"
    );
    assert!(
        is_write_class_tool("browser_workflow_replay"),
        "workflow replay can apply actions, so it must be write-class gated"
    );
}
