// src-tauri/src/main.rs
//
// Two entry modes:
//
// * Default — launch the Tauri desktop app (Grok Shell window).
// * `--mcp-server` — run the host MCP stdio server. Invoked by grok's
// MCP auto-discovery via the entry in `~/.grok/config.toml`. No UI,
// reads JSON-RPC from stdin, writes to stdout, exits on stdin close.
//
// We dispatch on `argv[1]` before touching Tauri so the binary can be
// double-purposed as both desktop app and headless MCP server.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
