# shellX architecture

This is the newcomer-readable map of how shellX is wired. If you are
reading the source for the first time, start here, then jump into the
module map below (§ "Module map") for per-file responsibilities.

shellX is a single Tauri 2 desktop app (Rust backend + WebView2/WKWebView
frontend) that hosts a grok-build child process per chat tab. It
exposes its UI surface over an HTTP+WS orchestration API
(`shellXagent`) and runs an MCP server so the child grok can reach
host-side tools (filesystem, vault, vision, subagents).

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
   external agents          remote grok               local grok
   (agent drivers,          (WSL / SSH via             (stdio child)
   Playwright,              dynamic `-R` tunnel)
   curl, CI)
```

- One Tauri app process. Each chat tab spawns one grok-build child via
  stdio (`Command::new("grok").arg("agent").arg("stdio")` for Local,
  `wsl.exe -d <distro> -e grok ...` for WSL, `ssh <host> -- ... grok ...`
  for SSH). See `acp.rs::start` per-transport spawn arms.
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
  Env `GROK_SHELL_DEBUG_SECRET` override. Older installs are
  auto-migrated.
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

**~50 endpoints:** `/connect`, `/prompt`, `/abort`, `/autonomy`,
`/state/{header,footer,ui,files,skills,github,subagents,sessions}`,
`/panels`, `/preview`, `/tools/{fs_watch,process_*,secret_get}`,
`/vault/{status,keys,get,set,delete}`, `/connections`,
`/sessions/history`, `/sessions/search`, `/sessions/:id`,
`/sessions/:id/snippet`, `/sessions/:id/archive`,
`/tabs/:id/archive`, `/screenshot`, `/plan`,
`/permissions/:reqId/respond`, `/diagnostics`,
`/github/pr/create`, `/events/recent`, WS `/events`.

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
permission/audit behavior matters.

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
- **`net_fetch`:** allow-list at `~/.shellx/net-allow.toml`,
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
