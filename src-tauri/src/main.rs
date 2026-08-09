// src-tauri/src/main.rs
//
// Two entry modes:
//
// * Default — launch the Tauri desktop app (Grok Shell window).
// * `--mcp-server` — run the host MCP stdio server for a ShellX-launched
// provider session. No UI, reads JSON-RPC from stdin, writes to stdout,
// exits on stdin close.
//
// We dispatch on `argv[1]` before touching Tauri so the binary can be
// double-purposed as both desktop app and headless MCP server.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(feature = "debug-api")]
    if args.get(1).map(String::as_str) == Some("--release-provider-action-fixture") {
        std::process::exit(run_release_provider_action_fixture(&args[2..]));
    }
    if args.get(1).map(|a| a.as_str()) == Some("--stdio-proxy") {
        std::process::exit(app_lib::run_stdio_proxy(&args[2..]));
    }
    if args.iter().any(|a| a == "--mcp-server") {
        if let Err(e) = app_lib::run_host_mcp_stdio() {
            eprintln!("host_mcp stdio server failed: {}", e);
            std::process::exit(1);
        }
        return;
    }
    app_lib::run();
}

#[cfg(feature = "debug-api")]
fn run_release_provider_action_fixture(args: &[String]) -> i32 {
    const ACTIONS: &[&str] = &[
        "activity-ask-agent",
        "browser-explain-page",
        "browser-send",
        "build-approve",
        "build-resume",
        "goal-approve",
        "goal-replan",
        "right-rail-connector-action",
        "right-rail-environment-ask",
        "tasks-row-ask",
        "tasks-visible-ask",
        "work-preview-ask-fix",
        "work-preview-browser-issue-fix",
        "work-preview-stage-ask-fix",
    ];
    let Some(action) = args.first().map(String::as_str) else {
        eprintln!("provider action fixture requires an action");
        return 2;
    };
    let Some(digest) = args.get(1).map(String::as_str) else {
        eprintln!("provider action fixture requires a prompt digest");
        return 2;
    };
    if !ACTIONS.contains(&action) {
        eprintln!("provider action fixture rejected unknown action");
        return 2;
    }
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        eprintln!("provider action fixture rejected invalid prompt digest");
        return 2;
    }
    println!(
        "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"shellx-provider-action-receipt\",\"type\":\"agent_message\",\"text\":\"SHELLX_PROVIDER_ACTION_RECEIPT {action} {digest}\"}}}}"
    );
    println!(
        "{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":0,\"output_tokens\":0}}}}"
    );
    0
}
