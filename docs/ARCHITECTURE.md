# shellX architecture

This is the newcomer-readable map of how shellX is wired. If you are
reading the source for the first time, start here, then jump into the
module map below (§ "Module map") for per-file responsibilities.

shellX is a single Tauri 2 desktop app (Rust backend + WebView2/WKWebView
frontend) that hosts Grok ACP sessions and provider CLI sessions (Codex CLI,
Claude Code, Antigravity) per chat tab. It exposes its UI surface over an
HTTP+WS orchestration API (`shellXagent`) and runs MCP servers so connected
agents can reach host-side tools (filesystem, vault, vision, subagents).

## Stack at a glance

- **Tauri 2** — Rust backend + system WebView frontend, single app
  process, IPC over `tauri::command` and `Channel`.
- **React + TypeScript** — UI under `src/`.
- **Agent Client Protocol (ACP)** — JSON-RPC over stdio between
  shellX and the grok-build child. Wire format calibrated against
  live `~/.shellx/sessions/<sid>.jsonl` captures.
- **axum + tokio** — both internal HTTP servers (shellXagent and
  host MCP) bind to `127.0.0.1` on dynamic ports. The bound ports
  are written to `~/.shellx/debug-api.port` and
  `~/.shellx/mcp-http.port`.
- **portable-pty** — embedded terminal (ConPTY on Windows, openpty
  on Linux). Used by the user-driven bottom-panel terminal only;
  ACP-side `terminal/create` is intercepted (see §2.4 below).
- **xcap + windows-sys PrintWindow** — window screenshot capture
  for `/screenshot`.
- **chacha20poly1305 + keyring-rs** — encrypted local vault with
  OS-keyring master key custody.

## Process model

```
+---------------------------------------------------------------+
|  shellX app (Tauri)                                           |
|                                                               |
|   React UI  <--Channel-->  Rust backend                       |
|                                |                              |
|       +------------------------+------------------------+     |
|       |                        |                        |     |
|   debug_api.rs              mcp_http.rs           host_mcp.rs |
|   (axum dynamic)            (axum dynamic)       (stdio + RPC)|
|       ^                        ^                        ^     |
|       |                        |                        |     |
+-------|------------------------|------------------------|-----+
        |                        |                        |
       external agents          remote agents             local agents
       (agent drivers,          (WSL / SSH via             (stdio/CLI child)
       Playwright,              dynamic `-R` tunnel
       curl, CI)                where needed)
```

- One Tauri app process. Grok tabs spawn a Grok ACP child via stdio
  (`Command::new("grok").arg("agent").arg("stdio")` for Local,
  `wsl.exe -d <distro> -e grok ...` for WSL, `ssh <host> -- ... grok ...`
  for SSH). See `acp.rs::start` per-transport spawn arms.
- Provider tabs use `provider_sessions.rs` to run Codex CLI, Claude Code, or
  Antigravity CLI as noninteractive provider processes. Codex and Claude can
  receive ShellX host MCP tooling; Antigravity is plain-text until its CLI
  exposes MCP/tool streaming.
- All servers bind `127.0.0.1` only — never exposed to LAN.
- Single-instance enforced via `tauri-plugin-single-instance`: second
  launch focuses the existing window.

## Four trust boundaries

shellX has four places where untrusted-or-semi-trusted bytes enter
the system. Each has explicit defense layers; we don't rely on
"the agent will behave."

### 1. shellXagent HTTP+WS on `127.0.0.1:<bound-debug-port>` (`debug_api.rs`)

The orchestration API. Drive any UI surface from external agents,
Playwright, CI, etc.

**Who calls it:** any process on the host with the bearer token.

**Defenses:**
- Bind `127.0.0.1` only.
- Preferred port `5757`; if busy, steps up and publishes the actual
  bound port to `~/.shellx/debug-api.port`.
- Bearer token: 16 bytes OsRng → 32 hex chars, file at
  `~/.shellx/shellxagent.token` mode 0600, constant-time compared.
  Env `SHELLX_DEBUG_SECRET` override, with
  `GROK_SHELL_DEBUG_SECRET` kept as a legacy fallback. Older installs
  are auto-migrated.
- Origin allow-list (Tauri origins + localhost + 127.0.0.1) checked
  before token. Missing Origin allowed so curl/scripts work — the
  bearer is the real gate in that case.
- `/health` exempt from token, NOT from origin.
- Bind-with-retry (15 × 2s on AddrInUse) so a quick relaunch
  through TIME_WAIT doesn't deadlock the new process.

**Trust assumption:** anyone holding the bearer token has full
control of the shellX UI and can read/write/diff/archive sessions
through the API. The token lives mode 0600 in the user's home —
same threat model as `~/.aws/credentials` or a `pass` store. A
compromised local OS-session attacker can read it directly.

The shipped route inventory changes as ShellX grows. Keep
[`API.md`](API.md) as the endpoint source of truth.

### 2. Host MCP HTTP on `127.0.0.1:<bound-mcp-port>` (`mcp_http.rs`)

The remote-grok transport for host MCP tools. When grok runs
inside WSL or over SSH, it can't see local stdio, so it reaches
host tools via Streamable HTTP on the bound MCP port (SSH adds a
matching `-R <bound>:127.0.0.1:<bound>` loopback forward).

**Who calls it:** the bundled host-MCP child inside grok-build,
authenticated by a separate bearer (audience separation from
shellXagent).

**Defenses:**
- Bind `127.0.0.1` only.
- Preferred port `5758`; if busy, steps up and publishes the actual
  bound port to `~/.shellx/mcp-http.port`.
- Bearer token at `~/.shellx/mcp.token`, 16 bytes OsRng, atomic
  0600. Legacy low-entropy tokens (pre-OsRng pid+nanos pattern,
  detected by ≥8 leading zero nibbles) auto-rotated on upgrade.
- `axum::extract::DefaultBodyLimit::max(32 MiB)` so the advertised
  16 MiB `fs_write` cap is real, not silently truncated by a
  smaller framework default.
- Origin allow-list mirrors the shellXagent debug API (checked BEFORE token →
  403 vs 401 distinguishable).
- Constant-time token compare.
- **Plan-mode write-class gate:** if the calling tab is in
  `plan` autonomy mode, write-class tools (`fs_write`,
  `fs_append`, `fs_copy`, `fs_delete`, `fs_ensure_dir`,
  `secret_set`, `secret_delete`, `process_signal`, `net_fetch`,
  `Agent`, `Agent_kill`, `mem_set`, `mem_delete`, `fs_watch`)
  are rejected at the gate. Resolution via `MCP-Tab-Id` header
  baked into each tab's `~/.grok/config.toml` snippet.

**Trust assumption:** the bearer in `mcp.token` is the only gate.
Anything inside the user's OS session that can read the file can
call every host MCP tool. The stdio variant of host_mcp (used on
Local Windows) has no token gate at all — anyone who can spawn
the binary with `--mcp-server` and pipe stdin gets full tool
access. This is by design: stdio is a parent-process relationship.

### 3. Host MCP stdio + tool surface (`host_mcp.rs`)

The actual tools — `fs_*`, `net_fetch`, `vision_describe`,
`secret_*`, `mem_*`, `Agent` (subagent fan-out), `process_*`,
  `screenshot_*`, `clock_now`/`sleep_ms`, `capabilities_summary`,
  `search_tool`. About 30 tools live, reachable as
  `grok-shell-host__<tool>` or, for the shellX-managed HTTP transport,
  `shellx-host-http__<tool>`. Mutating/tab-aware calls should prefer
  the HTTP-qualified name when advertised.

Native Grok file tools (`write`, `read_file`, `list_dir`, `grep`,
`search_replace`) are preferred for routine project edits. Host `fs_*`
stays available for Windows-parent paths from remote sessions, atomic or
binary operations, watch/copy/delete helpers, and cases where shellX host
permission/audit behavior matters. Host `fs_*` is HOME-scoped, not
project-scoped, but refuses known credential stores, shell startup files, SSH
and Git config, and user persistence paths.

Provider adapters reuse the same HTTP MCP surface instead of creating a
second host-tool implementation. Codex CLI sessions receive a managed
`shellx-host-http` streamable HTTP MCP override with bearer auth read from
`SHELLX_MCP_TOKEN`; ShellX injects a tab-bound token into the process
environment and uses `?tabId=<tab>` because the current Codex CLI does not
expose arbitrary MCP headers. Write-class MCP calls must present the
tab-bound token for the claimed tab; the global MCP token is kept for
health/read compatibility. Claude Code sessions receive a private
`~/.shellx/provider-mcp/claude-shellx-host-http-<tab>.json` config file with
the HTTP MCP URL and `MCP-Tab-Id` header. Antigravity is intentionally left
without ShellX MCP injection while `agy --print` exposes only plain text and no
MCP config surface.

Provider discovery is scoped to the selected connection preset. A preset is one
runtime identity: one local user, one WSL distro user, or one SSH destination
with that environment's HOME, PATH, and provider auth files. If the same machine
has two separate accounts for the same provider, model selection must use
separate connection presets rather than letting ShellX silently pick between
auth contexts.

Provider sessions default to ShellX Full Auto, which maps to native provider
bypass flags (`bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`,
or equivalent). This is a trust-boundary decision, not just UI state: ShellX
can stream and audit many provider events, but native provider tools may run
without ShellX permission-pill confirmation. The user-facing contract is to
scope tabs to trusted project folders and trusted local/WSL/SSH environments.

**Trust assumption:** every byte that arrives at a tool came from
the agent — treat it as adversarial. The tools are not "agent
helpers" but "host capabilities that happen to be agent-callable",
and each one enforces its own contract:

- **Filesystem (`fs_read`, `fs_write`, `fs_read_binary`,
  `fs_copy`, `fs_delete`, `fs_grep`, etc.):** `validate_fs_path`
  enforces absolute, non-null, no `..` traversal, no POSIX-on-
  Windows except UNC/`/mnt/c`/`/cygdrive`. Write-class tools have
  16 MiB caps. `fs_copy` and `fs_delete` additionally canonicalize
  HOME and reject anything outside it. (See the §"Host MCP HTTP" section above
  for the full tool table.)
- **`net_fetch`:** allow-list at `~/.shellx/net_allow.toml`,
  hard-coded self-allow for `127.0.0.1` / `localhost` / `::1`
  so grok can self-introspect (#302). Reqwest client; redirects
  follow default policy (sensitive headers stripped on cross-
  host).
- **`vision_describe`:** xAI Grok multimodal vision. Uses Grok OAuth
  from `~/.grok/auth.json` by default, then falls back to
  `GROK_VISION_API_KEY` / `XAI_API_KEY`, vault `xai/api-key`, and
  pass-store keys. 20 MiB image cap. POSIX paths auto-translate to
  `\\wsl$\<distro>\…` on Windows.
- **`Agent` (subagent fan-out):** `subagent::spawn_subagent` with
  ledger_dir path validation, 60-min timeout clamp, 6-concurrent
  cap (`SHELLX_MAX_SUBAGENTS` override), credential-shaped task
  text scrubbed before display.
- **Credential redaction:** every `mcp-events.jsonl` line goes
  through `redact_if_credential_pattern` (21+ patterns:
  `Bearer …`, `ghp_…`, `xai-…`, `sk-…`, `ya29.…`, etc.).

### 4. ACP wire to grok (`acp.rs`)

JSON-RPC over stdio between shellX and the grok-build child. Bi-
directional — shellX sends `session/prompt`, grok sends
`session/update`, `session/request_permission`, `terminal/*`,
`fs/*`, `_x.ai/*` notifications.

**What we trust from grok:** method names (explicit match, unknown
methods get -32601), JSON-RPC param shapes (defensively parsed
with `.and_then`/`.unwrap_or`).

**What we DON'T trust from grok:**
- **Raw shell strings.** `terminal/create` is intercepted on
  every transport. Local -> redirected to shellX `Agent`
  subagent. WSL/SSH → user-facing error (PTY round-trip is blocked
  upstream in grok-build 0.1.211). No host PTY is ever spawned
  in response to a grok request. This is the load-bearing
  safety property; a regression here would let grok run arbitrary
  shell. See `acp.rs::handle_terminal_create`.
- **Cwd/paths.** Every path arriving over ACP goes through
  `validate_fs_path` on the way to `fs_*` tools.

**Trust we DO give the operator:** SSH host/port/key_vault_ref/
remote_grok_path come from `connections.json`, written by the user
via the UI. SSH destinations are validated with
`acp.rs::validate_ssh_destination_arg`; command fragments use
`acp.rs::shell_quote_for_remote`, with operator-owned connection fields
kept inside that connection preset boundary.

## Cross-provider generated assets

Generated images, videos, and future provider-side artifacts stay owned by
the provider session that produced them. Grok paths may live under
`~/.grok`, WSL paths may live in the distro filesystem, and SSH paths may
refer to a remote host. The renderer builds a session asset registry from
the same chat/session event stream that powers the media board, preserving
the source tab id, provider session id, cwd, transport, and original path.

Preview is source-aware: opening a reusable asset reads it through the
source tab context, not through whichever tab is active. Reuse is explicit:
`copy_asset_to_scope` imports the source file into the target session's
`<cwd>/.shellx/assets/` directory and returns the path as the target
provider should see it. This keeps project working trees clean (`.shellx/`
is ignored), avoids widening the global preview scope, and prevents ShellX
from silently routing a request to another provider. Importing into SSH
sessions is intentionally rejected for now; users can copy the original
path or import from inside the remote session until remote writes are added.

## Where to read next

- [`docs/API.md`](API.md) — the shellXagent JSON-RPC over HTTP+WS
  endpoint inventory + curl recipes.
- [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) — single-user posture +
  trust surface enumeration.

## Module map (Rust, `src-tauri/src/`)

The four largest modules carry 60% of the Rust LOC and are
candidates for further split (#F-05 in the codebase audit).

| File | LOC | Role |
|---|---|---|
| `acp.rs` | ~4200 | ACP wire to grok, SessionRegistry, terminal/* intercept, per-transport spawn |
| `host_mcp.rs` | ~4000 | MCP stdio server + every fs_* / net_* / process_* / agent_* / vision tool |
| `debug_api.rs` | ~4000 | shellXagent HTTP+WS server, auth, ~50 endpoints |
| `lib.rs` | ~2300 | Tauri setup, IPC commands, session lifecycle, host MCP injection |
| `mcp_http.rs` | ~700 | HTTP MCP server (origin allow-list, token gate, plan-mode gate) |
| `host_mcp.rs::validate_fs_path` | ~100 | Single path-policy chokepoint for fs_* tools |
| `subagent.rs` | ~600 | `Agent` fan-out: spawn, registry, ledger, output capture |
| `vault.rs` | ~300 | chacha20poly1305 + keyring-rs encrypted secret store |
| `session_archive.rs` | ~700 | Local zip + SSH tar.gz streaming archive |
| `mcp_marketplace.rs` | ~400 | Marketplace state, tier S/A/B/C catalog, install/enable plumbing |
| `winproc.rs` | ~200 | Windows job-object kill-on-close; taskkill exit-128 silence |
| `process_registry.rs` | ~200 | Tracks shellX-spawned child processes for `process_signal` |

Frontend lives under `src/`. Entry is `src/App.tsx`; settings under
`src/components/settings/`; the chat surface is `src/components/ChatOutput.tsx`.
