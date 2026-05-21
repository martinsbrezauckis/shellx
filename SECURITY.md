# Security policy

## Reporting a vulnerability

Email security disclosures to <martins.brezauckis@gmail.com> with the
subject line `[shellX security]`. Please do not file a public GitHub
issue for security bugs — coordinated disclosure first.

I aim to acknowledge within 72 hours and patch critical issues within
14 days. If you receive no response within 7 days, it is fine to
escalate by opening a public issue saying "security report not
acknowledged" (without details).

## Scope

In scope:
- The shellX desktop app (Tauri 2, Rust backend, React frontend).
- The bundled host-MCP server (`grok-shell-host` stdio and Streamable
  HTTP on `127.0.0.1:<bound-mcp-port>`).
- The shellXagent HTTP+WS API on `127.0.0.1:<bound-debug-port>`.
- The encrypted vault (`chacha20poly1305` + `keyring-rs`).
- Anything under `src-tauri/` or `src/` in this repo.

Out of scope:
- Third-party MCP servers installed through the marketplace.
- `grok-build` itself (xAI's client) — report those to
  [xAI](https://x.ai).
- Upstream operating-system or browser-engine bugs (WebView2, WKWebView).

## Trust model

shellX assumes that any local OS-session attacker can read files in
the user's home directory, including the bearer tokens at
`~/.shellx/shellxagent.token` and `~/.shellx/mcp.token`. The
defenses we ship raise the cost for an agent or remote process
that does NOT have local read access; they do not protect against
malware running as the same user. This is the same threat model as
`~/.aws/credentials` or a `pass` store. Hardening notes live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) under "Four trust
boundaries".
