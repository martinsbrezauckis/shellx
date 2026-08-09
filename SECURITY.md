# Security policy

## Reporting a vulnerability

Email security disclosures to <martins.brezauckis@gmail.com> with the
subject line `[shellX security]`. Please do not file a public GitHub
issue for security bugs — coordinated disclosure first.

You can alternatively use
[GitHub private vulnerability reporting](https://github.com/martinsbrezauckis/shellx/security/advisories/new).
Do not include exploit details in a public issue.

I aim to acknowledge within 72 hours and patch critical issues within
14 days. If you receive no response within 7 days, it is fine to
escalate by opening a public issue saying "security report not
acknowledged" (without details).

## Supported versions

The latest stable ShellX release receives security fixes. A fix may be
backported to the immediately preceding release when the updater path or impact
makes that necessary, but older versions should be upgraded before reporting a
compatibility-only issue. Pre-release builds are supported only long enough to
qualify the next stable release.

## Scope

In scope:
- The shellX desktop app (Tauri 2, Rust backend, React frontend).
- The bundled ShellX host MCP server (`shellx-host-http` Streamable
  HTTP on `127.0.0.1:<bound-mcp-port>` and the legacy
  `grok-shell-host` stdio/tool-name compatibility surface).
- The shellXagent HTTP+WS API on `127.0.0.1:<bound-debug-port>`.
- The encrypted vault (`chacha20poly1305` + `keyring-rs`).
- ShellX Browser runtime and protocol code under `shellx-browser/`,
  `src/browser/`, and the Browser Rust modules.
- The vendored shared Vault client/broker under `vendor/shellx-vault/`.
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
[docs/public/ARCHITECTURE.md](docs/public/ARCHITECTURE.md) under "Four trust
boundaries".

ShellX's normal agent workflow is Full Auto. Provider sessions and Build
work can run with provider-native bypass permission flags. Report issues
where the UI or docs hide that mode, where Full Auto reaches a broader
filesystem/environment than the selected project, or where secrets are
logged while auto tools are running.

Last reviewed: 2026-08-01. Review this policy with each stable release and
whenever the Browser, Vault, updater, or host-MCP trust boundary changes.
