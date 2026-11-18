use super::*;
use serde_json::json;

/// Audit finding #376 H1 — nested `headers.Authorization` and
/// `headers.Cookie` must be redacted to "***REDACTED***" so
/// net_fetch args don't leak bearer tokens / session cookies into
/// the DebugHub event ring. Top-level fields named with sensitive
/// markers (apiKey, password, secret) must also redact. Recursion
/// covers Object AND Array.
#[test]
fn scrub_credentials_redacts_nested_headers() {
    let fake_token = ["xai-supersecret-", "token-12345"].concat();
    let mut v = json!({
        "url": "https://example.com/api",
        "method": "GET",
        "headers": {
            "Authorization": format!("Bearer {fake_token}"),
            "Cookie": "session=abcdef; csrf=ghijkl",
            "Content-Type": "application/json"
        },
        "apiKey": "live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "password": "hunter2",
        "client_secret": "shh-very-secret",
        "X-API-Key": "x-key-value",
        "nonSensitive": "keep-me-visible"
    });
    scrub_credentials(&mut v);
    // Sensitive top-level scalars: all redacted.
    assert_eq!(v["apiKey"], "***REDACTED***");
    assert_eq!(v["password"], "***REDACTED***");
    assert_eq!(v["client_secret"], "***REDACTED***");
    assert_eq!(v["X-API-Key"], "***REDACTED***");
    // Nested header redaction — the audit's load-bearing case.
    assert_eq!(v["headers"]["Authorization"], "***REDACTED***");
    assert_eq!(v["headers"]["Cookie"], "***REDACTED***");
    // Non-sensitive sibling under the same parent kept verbatim.
    assert_eq!(v["headers"]["Content-Type"], "application/json");
    // Top-level non-sensitive kept verbatim.
    assert_eq!(v["url"], "https://example.com/api");
    assert_eq!(v["method"], "GET");
    assert_eq!(v["nonSensitive"], "keep-me-visible");
}

/// Audit finding #376 H1 — recursion must reach into ARRAYS of
/// credential-bearing objects (a tools-call passing multiple
/// headers as an array of {name,value} pairs). Each nested
/// sensitive value must be redacted.
#[test]
fn scrub_credentials_recurses_into_arrays() {
    let mut v = json!({
        "batch": [
            {"name": "step1", "token": "tok-1-leak"},
            {"name": "step2", "authorization": "Bearer step-2-leak"},
            {"name": "step3", "data": "ok"}
        ]
    });
    scrub_credentials(&mut v);
    assert_eq!(v["batch"][0]["token"], "***REDACTED***");
    assert_eq!(v["batch"][1]["authorization"], "***REDACTED***");
    assert_eq!(v["batch"][2]["data"], "ok"); // non-sensitive kept
    assert_eq!(v["batch"][0]["name"], "step1");
}

/// Audit finding #376 H1 — case-insensitive key matching. Capital
/// `AUTHORIZATION` / mixed `Set-Cookie` / lowercase `secret_key`
/// must all redact.
#[test]
fn scrub_credentials_case_insensitive_keys() {
    let mut v = json!({
        "AUTHORIZATION": "Bearer A",
        "Set-Cookie": "x=1",
        "secret_key": "s",
        "AccessToken": "t",
        "Plain": "p"
    });
    scrub_credentials(&mut v);
    assert_eq!(v["AUTHORIZATION"], "***REDACTED***");
    assert_eq!(v["Set-Cookie"], "***REDACTED***");
    assert_eq!(v["secret_key"], "***REDACTED***");
    assert_eq!(v["AccessToken"], "***REDACTED***");
    assert_eq!(v["Plain"], "p");
}

#[test]
fn scrub_credentials_preserves_plural_routing_ids() {
    let fake_token = ["xai-abcdefghijkl", "mnopqrstuvwxyz123456"].concat();
    let mut v = json!({
        "subagent_ids": [
            "872283ba-9d58-4f60-8652-d93bc008bc73",
            "759bb620-1148-4f56-85c9-e7b00ac95338"
        ],
        "requestIds": ["req-01", "req-02"],
        "token": fake_token
    });
    scrub_credentials(&mut v);
    assert_eq!(v["subagent_ids"][0], "872283ba-9d58-4f60-8652-d93bc008bc73");
    assert_eq!(v["subagent_ids"][1], "759bb620-1148-4f56-85c9-e7b00ac95338");
    assert_eq!(v["requestIds"][0], "req-01");
    assert_eq!(v["requestIds"][1], "req-02");
    assert_eq!(v["token"], "***REDACTED***");
}

#[test]
fn scrub_credentials_keeps_build_scratchboard_slug_paths() {
    let mut v = json!({
        "content": {
            "text": "C:\\Users\\FixtureUser\\Downloads\\ms-paint-11-api\\build.build-paint-fix-0136.bd5c13c6-1b6.md"
        },
        "chunk": "build-paint-fix-0136.",
        "shortHash": "bd5c13c6-1b6"
    });
    scrub_credentials(&mut v);
    assert_eq!(
            v["content"]["text"],
            "C:\\Users\\FixtureUser\\Downloads\\ms-paint-11-api\\build.build-paint-fix-0136.bd5c13c6-1b6.md"
        );
    assert_eq!(v["chunk"], "build-paint-fix-0136.");
    assert_eq!(v["shortHash"], "bd5c13c6-1b6");
}

#[test]
fn mcp_tab_id_prefers_header_over_query() {
    let mut headers = HeaderMap::new();
    headers.insert("MCP-Tab-Id", "header-tab".parse().unwrap());
    let uri: axum::http::Uri = "/mcp?tabId=query-tab".parse().unwrap();

    assert_eq!(
        mcp_tab_id_from_headers_or_query(&headers, &uri).as_deref(),
        Some("header-tab")
    );
}

#[test]
fn mcp_tab_id_accepts_query_fallback_for_headerless_clients() {
    let headers = HeaderMap::new();
    let uri: axum::http::Uri = "/mcp?tabId=codex-tab-7".parse().unwrap();

    assert_eq!(
        mcp_tab_id_from_headers_or_query(&headers, &uri).as_deref(),
        Some("codex-tab-7")
    );
}

#[test]
fn mcp_tab_id_query_fallback_decodes_encoded_tab_id() {
    let headers = HeaderMap::new();
    let uri: axum::http::Uri = "/mcp?tabId=tab%20A%2F%231".parse().unwrap();

    assert_eq!(
        mcp_tab_id_from_headers_or_query(&headers, &uri).as_deref(),
        Some("tab A/#1")
    );
}

#[test]
fn mcp_tab_id_query_fallback_keeps_distinct_special_char_tabs() {
    let headers = HeaderMap::new();
    let uri_a: axum::http::Uri = "/mcp?tabId=tab%20A%2F%231".parse().unwrap();
    let uri_b: axum::http::Uri = "/mcp?tabId=tabA1".parse().unwrap();

    assert_ne!(
        mcp_tab_id_from_headers_or_query(&headers, &uri_a),
        mcp_tab_id_from_headers_or_query(&headers, &uri_b),
    );
}

#[test]
fn tab_bound_mcp_tokens_are_scoped_to_one_tab() {
    let base = "0123456789abcdef0123456789abcdef";
    let tab_a = tab_bound_mcp_token_from_base(base, "tab-a");
    let tab_b = tab_bound_mcp_token_from_base(base, "tab-b");

    assert_ne!(tab_a, base);
    assert_ne!(tab_a, tab_b);
    assert!(token_matches_tab(&tab_a, base, "tab-a"));
    assert!(!token_matches_tab(&tab_a, base, "tab-b"));
}

#[test]
fn health_identifies_the_exact_candidate_process_and_bound_port() {
    let value = serde_json::to_value(health_response(31_024, "~/.shellx/mcp.token"))
        .expect("health response serializes");

    assert_eq!(value["ok"], true);
    assert_eq!(value["processId"], std::process::id());
    assert_eq!(value["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        value["buildCommit"],
        crate::build_metadata::SHELLX_BUILD_COMMIT
    );
    assert_eq!(value["mcp_port"], 31_024);
    assert_eq!(value["mcpPort"], 31_024);
    assert_eq!(value["token_source"], "~/.shellx/mcp.token");
    assert_eq!(value["tokenSource"], "~/.shellx/mcp.token");
}

// ──────────────────────────────────────────────────────────────
// H2 token strategy tests (2026-05-20).
// // Goal: prove the snippet writer no longer bakes a literal Bearer
// token into the TOML and instead emits the env-var indirection
// form. Also prove the migrator rewrites legacy Bearer-form
// snippets in-place.
// ──────────────────────────────────────────────────────────────

/// H2: the fresh-write snippet must use env-var indirection, NOT
/// the literal Bearer line. We pass a sentinel "DEADBEEF" token
/// argument and assert it does NOT appear in the rendered TOML —
/// that single check fences off any future regression where a
/// caller accidentally re-introduces the literal token.
/// /// We also check the explicit positive signals:
/// - `bearer_token_env_var = "SHELLX_MCP_TOKEN"` is present
/// - the `[mcp_servers.shellx-host-http]` table is inline-table
/// form (NOT `[[mcp_servers]]` — that silently fails to load
/// in grok-build 0.1.212).
/// - the `MCP-Tab-Id` header is still injected (load-bearing for
/// tab autonomy resolution).
/// - no `Authorization = "Bearer ...` line anywhere in the body.
/// We search for `Bearer ` (with trailing space) so the
/// `SHELLX_MCP_TOKEN` env var name itself can't trigger a false
/// positive match.
#[test]
fn http_config_snippet_uses_env_var_not_literal_bearer() {
    let snippet = http_config_snippet_toml(5758, "DEADBEEFDEADBEEFDEADBEEFDEADBEEF", "tab-7");
    assert!(
        snippet.contains("bearer_token_env_var = \"SHELLX_MCP_TOKEN\""),
        "snippet missing env-var indirection: {}",
        snippet
    );
    assert!(
        !snippet.contains("Bearer "),
        "snippet still contains literal Bearer line: {}",
        snippet
    );
    assert!(
        !snippet.contains("DEADBEEF"),
        "snippet leaked the literal token into config.toml: {}",
        snippet
    );
    assert!(
        snippet.contains("[mcp_servers.shellx-host-http]"),
        "snippet must use inline-table form, not array-of-tables: {}",
        snippet
    );
    assert!(
        !snippet.contains("[[mcp_servers"),
        "snippet must NOT use array-of-tables form: {}",
        snippet
    );
    assert!(
        snippet.contains("MCP-Tab-Id = \"tab-7\""),
        "snippet missing tab id header: {}",
        snippet
    );
}

/// H2 migrator: feed a fixture TOML that simulates a pre-H2
/// shellX-written config.toml — sentinel-wrapped block with a
/// literal `Authorization = "Bearer <hex>"` line in the
/// `.headers` sub-table. Run the migrator. Assert:
/// - the literal token is gone
/// - `bearer_token_env_var = "SHELLX_MCP_TOKEN"` is present
/// - the rest of the file (a user-added unrelated MCP server)
/// survives untouched.
#[test]
fn migrate_http_snippet_rewrites_legacy_bearer_form() {
    let fixture = format!(
        "# user-added section above\n\
             [mcp_servers.my-other]\n\
             command = \"/bin/echo\"\n\n\
             {begin}\n\
             [mcp_servers.shellx-host-http]\n\
             url = \"http://localhost:5758/mcp\"\n\
             enabled = true\n\
             startup_timeout_sec = 15\n\
             [mcp_servers.shellx-host-http.headers]\n\
             Authorization = \"Bearer 0123456789abcdef0123456789abcdef\"\n\
             MCP-Tab-Id = \"default\"\n\
             {end}\n\
 # user-added section below\n\
             [mcp_servers.another]\n\
             url = \"http://localhost:9999\"\n",
        begin = HTTP_SNIPPET_BEGIN,
        end = HTTP_SNIPPET_END,
    );

    let (migrated, changed) = migrate_http_snippet_to_env_var(&fixture);
    assert!(changed, "migrator should report change on legacy fixture");
    assert!(
        !migrated.contains("Bearer "),
        "migrated text still contains literal Bearer line: {}",
        migrated
    );
    assert!(
        !migrated.contains("0123456789abcdef"),
        "migrated text leaked literal token hex: {}",
        migrated
    );
    assert!(
        migrated.contains("bearer_token_env_var = \"SHELLX_MCP_TOKEN\""),
        "migrated text missing env-var indirection: {}",
        migrated
    );
    // Sibling sections preserved.
    assert!(
        migrated.contains("[mcp_servers.my-other]"),
        "migrator clobbered unrelated user MCP server: {}",
        migrated
    );
    assert!(
        migrated.contains("[mcp_servers.another]"),
        "migrator clobbered trailing user MCP server: {}",
        migrated
    );
    // MCP-Tab-Id (other header) survives — only the Authorization
    // line is dropped.
    assert!(
        migrated.contains("MCP-Tab-Id = \"default\""),
        "migrator dropped MCP-Tab-Id header: {}",
        migrated
    );
}

/// H2 migrator idempotency: running the migrator on a file
/// already in env-var form returns `changed = false` and leaves
/// the source untouched. This guards against the boot-time
/// migrator churning mtimes on every launch.
#[test]
fn migrate_http_snippet_idempotent_on_current_form() {
    let current = format!(
        "{begin}\n\
             [mcp_servers.shellx-host-http]\n\
             url = \"http://localhost:5758/mcp\"\n\
             enabled = true\n\
             startup_timeout_sec = 15\n\
             bearer_token_env_var = \"SHELLX_MCP_TOKEN\"\n\
             [mcp_servers.shellx-host-http.headers]\n\
             MCP-Tab-Id = \"default\"\n\
             {end}\n",
        begin = HTTP_SNIPPET_BEGIN,
        end = HTTP_SNIPPET_END,
    );
    let (out, changed) = migrate_http_snippet_to_env_var(&current);
    assert!(!changed, "current-form file should not trigger migration");
    assert_eq!(out, current, "current-form file should be byte-identical");
}

/// Regression: the write-class enumerator must cover every
/// tool category that mutates state on the host. New write-class
/// tools added later MUST update is_write_class_tool too so the
/// missing-MCP-Tab-Id default-deny gate fires on them.
#[test]
fn is_write_class_tool_covers_known_writers() {
    use std::collections::BTreeSet;

    let expected: BTreeSet<&str> = [
        "host_act",
        "fs_write",
        "fs_append",
        "fs_copy",
        "fs_delete",
        "fs_ensure_dir",
        "process_signal",
        "secret_set",
        "secret_delete",
        "net_fetch",
        "security_scan",
        "vision_describe",
        "voice_tts",
        "x_search",
        "voice_stt_v2",
        "vision_describe_v2",
        "Agent",
        "Agent_kill",
        "mem_set",
        "mem_delete",
        "fs_watch",
        "fs_unwatch",
        "goal_complete",
        "task_manage",
        "build_receipt",
        "build_checkpoint",
        "preview_start",
        "build_complete",
        "send_prompt_to_session",
        "send_prompt_to_provider",
        "browser_act",
        "cut_act",
        "browser_navigate",
        "browser_click_ref",
        "browser_click_at",
        "browser_fill_ref",
        "browser_type_text",
        "browser_clear_site_data",
        "browser_run_steps",
        "browser_fill_from_vault",
        "browser_fill_profile_card",
        "browser_capture_secret_to_vault",
        "browser_read_email_code",
        "browser_use_agent_wallet",
        "browser_screenshot",
        "browser_save_page",
        "browser_resolve_dialog",
        "browser_trace_open",
        "browser_flight_recorder_export",
        "browser_evaluation_write",
        "browser_workflow_save",
        "browser_workflow_replay",
        "vault_request_grant",
        "vault_agent_request",
        "vault_generate",
    ]
    .into_iter()
    .collect();
    let actual: BTreeSet<&str> = crate::host_mcp::WRITE_CLASS_TOOLS.iter().copied().collect();
    assert_eq!(actual, expected, "write-class table drifted");

    for w in expected {
        assert!(is_write_class_tool(w), "write-class missed: {w}");
    }
    for r in [
        "fs_read",
        "fs_list_dir",
        "fs_grep",
        "fs_stat",
        "secret_get",
        "secret_list",
        "mem_get",
        "mem_list",
        "clock_now",
        "search_tool",
        "browser_read",
    ] {
        assert!(
            !is_write_class_tool(r),
            "read-class wrongly flagged write: {r}"
        );
    }
}

#[test]
fn write_class_gate_action_prompts_legacy_modes_and_allows_auto() {
    assert_eq!(
        write_class_gate_action("host_act", Some("tab-a"), Some("plan")),
        WriteClassGateAction::RejectObserve
    );
    assert_eq!(
        write_class_gate_action("host_read", Some("tab-a"), Some("plan")),
        WriteClassGateAction::Allow
    );
    assert_eq!(
        write_class_gate_action("fs_write", Some("tab-a"), Some("default")),
        WriteClassGateAction::Prompt
    );
    assert_eq!(
        write_class_gate_action("fs_write", Some("tab-a"), Some("acceptEdits")),
        WriteClassGateAction::Prompt
    );
    assert_eq!(
        write_class_gate_action("fs_write", Some("tab-a"), Some("bypassPermissions")),
        WriteClassGateAction::Allow
    );
    assert_eq!(
        write_class_gate_action("fs_write", Some("tab-a"), Some("auto")),
        WriteClassGateAction::Allow
    );
    assert_eq!(
        write_class_gate_action("fs_write", Some("tab-a"), Some("plan")),
        WriteClassGateAction::RejectObserve
    );
    assert_eq!(
        write_class_gate_action("fs_write", None, Some("bypassPermissions")),
        WriteClassGateAction::RejectMissingTab
    );
    assert_eq!(
        write_class_gate_action("fs_read", Some("tab-a"), Some("plan")),
        WriteClassGateAction::Allow
    );
}

/// H2 migrator no-op on files without our managed block: a
/// `~/.grok/config.toml` that contains only user-added entries
/// must be returned unchanged. Defense against the migrator ever
/// reaching into non-shellX sections.
#[test]
fn migrate_http_snippet_skips_files_without_managed_block() {
    let user_only = "[mcp_servers.user]\n\
                         command = \"/bin/cat\"\n\
                         [mcp_servers.user.headers]\n\
                         Authorization = \"Bearer user-token-keep-me\"\n";
    let (out, changed) = migrate_http_snippet_to_env_var(user_only);
    assert!(
        !changed,
        "migrator must not touch files lacking our managed block"
    );
    assert_eq!(out, user_only);
    assert!(
        out.contains("Bearer user-token-keep-me"),
        "user's own bearer line must be preserved: {}",
        out
    );
}
