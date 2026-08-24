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
- **portable-pty** — operator-owned embedded terminal (ConPTY on Windows;
  native PTY support on Linux and macOS). Provider-originated ACP
  `terminal/*` is advertised as unavailable and rejected (see §2.4 below).
- **xcap + windows-sys PrintWindow** — window screenshot capture
  for `/screenshot`.
- **ShellX Vault broker + chacha20poly1305/keyring-rs** — encrypted local or
  connected Vault resources, recovery material, grants, safe-folder contracts,
  and remembered-device custody.

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
  `wsl.exe -d <distro> -e grok ...` for WSL, and `ssh <host> -- ...` for
  POSIX, native Windows PowerShell, or Windows-plus-WSL SSH). Native Windows
  stays in PowerShell and does not require WSL; Windows-plus-WSL is selected
  only by an explicit runtime and distro. See
  `acp.rs::start` per-transport spawn arms.
- Provider tabs use `provider_sessions.rs` to run Codex CLI, Claude Code, or
  Antigravity CLI as noninteractive provider processes. Codex and Claude can
  receive ShellX host MCP tooling. Antigravity 1.1.8+ emits structured NDJSON
  for text, tool, subagent, conversation, and usage events, but its ShellX host
  MCP bridge remains fail-closed until a live print-mode tool-call canary passes.
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
- Bearer token: 16 bytes OsRng → 32 hex chars, stored in a private per-user
  credential file with mode 0600 on macOS/Linux and the inherited user-private
  profile ACL on Windows, then compared in constant time.
  Env `SHELLX_DEBUG_SECRET` override, with
  `GROK_SHELL_DEBUG_SECRET` kept as a legacy fallback. Older installs
  are auto-migrated.
- Origin allow-list (Tauri origins + localhost + 127.0.0.1) checked
  before token. Missing Origin allowed so curl/scripts work — the
  bearer is the real gate in that case.
- `/health` exempt from token, NOT from origin.
- Immediate bounded port fallback on `AddrInUse`; ShellX tries the preferred
  port once, then steps through the documented fallback ports and publishes
  the actual bound port.

**Trust assumption:** anyone holding the bearer token has full
control of the shellX UI and can read/write/diff/archive sessions
through the API. The token uses mode 0600 on macOS/Linux and the
user-private profile ACL on Windows — the same threat model as
`~/.aws/credentials` or a `pass` store. A
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
- A separate 16-byte OsRng bearer is atomically stored in a private per-user
  credential file; mode 0600 on macOS/Linux and the inherited user-private
  profile ACL on Windows.
  Legacy low-entropy tokens (pre-OsRng pid+nanos pattern,
  detected by ≥8 leading zero nibbles) auto-rotated on upgrade.
- Startup establishes one process-owned token authority only after private
  persistence succeeds. Missing/relative HOME, unreadable or linked token
  files, and atomic-write failures leave Host MCP unavailable instead of
  exposing a memory-only bearer. Running clients and middleware derive from
  that same immutable authority rather than re-reading mutable disk.
- `axum::extract::DefaultBodyLimit::max(32 MiB)` so the advertised
  16 MiB `fs_write` cap is real, not silently truncated by a
  smaller framework default.
- Origin allow-list mirrors the shellXagent debug API (checked BEFORE token →
  403 vs 401 distinguishable).
- Constant-time token compare.
- **Plan-mode write-class gate:** if the calling tab is in `plan` autonomy
  mode, every entry in `WRITE_CLASS_TOOLS` is rejected at the gate. This
  includes mutating filesystem, process, network, Vault, Browser, media,
  goal/build, search, voice, and subagent actions. The authoritative list is
  `WRITE_CLASS_TOOLS` in `src-tauri/src/host_mcp.rs`; the release inventory
  proves tool presence but does not classify write authority. Tab identity and its
  derived bearer are supplied only in the provider session's ShellX-managed
  MCP payload; project `.grok/config.toml` files are migration inputs and are
  not rewritten with replacement ShellX sections.

**Trust assumption:** the MCP bearer is the only HTTP gate.
Anything inside the user's OS session that can read its private credential can
call every host MCP tool. The stdio variant of host_mcp (used on
Local Windows) has no token gate. A process that spawns the binary with
`--mcp-server` and pipes stdin gets read-class tool access; standalone stdio
rejects every write-class tool because it cannot resolve a tab or permission
gate. This is by design: stdio is a parent-process relationship.

### 3. Host MCP stdio + tool surface (`host_mcp.rs`)

The callable catalog contains 108 host-MCP surfaces in the current release
inventory. Families include `fs_*`, Browser read/action/workflow tools, Vault
grants and mediated secret operations, build/goal orchestration, provider
handoffs, `net_fetch`, vision, voice, X search, `mem_*`, `Agent` fan-out,
`process_*`, screenshots, clock/sleep, compact ShellX Cut discovery/execution,
`capabilities_summary`, and `search_tool`. The authoritative count and names live in
`[retired maintainer contract]`. Tools are reachable as
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

Tools also renders a selected-session `shellx.cut.tooling-status.v1`
projection from this host boundary. Its Check path performs a bounded Cut
status probe and never starts the editor; the separate `cut_tooling_open` Tauri
command is available only after an explicit operator action. The status is
compact by design and never carries Cut's generated verb catalogue. When
ShellX tooling exposure is enabled, Local, WSL, and SSH provider sessions share
the parent desktop-host Cut projection: WSL reaches the host through the ShellX
bridge and SSH through the tab-bound reverse tunnel.

Provider adapters reuse the same HTTP MCP surface instead of creating a
second host-tool implementation. Codex CLI sessions receive a managed
`shellx-host-http` streamable HTTP MCP override with bearer auth read from
`SHELLX_MCP_TOKEN`; ShellX injects a tab-bound token into the process
environment and uses `?tabId=<tab>` because the current Codex CLI does not
expose arbitrary MCP headers. Write-class MCP calls must present the
tab-bound token for the claimed tab; the global MCP token is kept for
health/read compatibility. Claude Code sessions receive a private
`~/.shellx/provider-mcp/claude-shellx-host-http-<tab>.json` config file with
the HTTP MCP URL and `MCP-Tab-Id` header. Antigravity 1.1.8+ sessions receive a
private additional workspace under `~/.shellx/provider-mcp/` containing a
uniquely named main-agent definition. ShellX selects that agent and adds only
that private workspace for the launched process, so Antigravity keeps its
native file, command, Browser, search, image, and subagent tools without making
ShellX guidance globally discoverable. Antigravity host MCP stays disabled:
1.1.8 through 1.1.11 print-mode conformance tests discovered a workspace server
schema, but none produced a real MCP `tools/call` through ShellX's custom-agent
session shape. The 1.1.11 execution backend rejected the wrapper, leaf, and
server-qualified tool names as unknown, which is not accepted as tool-execution
proof even though the process reported success.
Codex receives the same compact ShellX rule through a per-process config
override and Claude through `--append-system-prompt`; direct provider launches
do not inherit these rules.

Provider discovery is scoped to the selected connection preset. A preset is one
runtime identity: one local user, one WSL distro user, or one SSH destination
plus its explicit POSIX, native Windows, or Windows-plus-WSL runtime. Native
Windows provider commands use encoded PowerShell launchers and stream setup
values over stdin; Windows paths are never silently interpreted as POSIX paths.
Provider run, abort, health, recent-run, and stored-conversation keys include
that SSH runtime and, for Windows-plus-WSL, its normalized distro. Two routes to
the same Windows OpenSSH host therefore cannot collide merely because they use
the same host, port, or Vault-backed identity file.
The same runtime frame now covers remote file/media reads, activity evidence,
Git and archives, marketplace health probes, Work Preview server tunnels with
remote disconnect cleanup, and ShellX-managed Grok subagent bootstrap. These
source paths do not by themselves prove a provider is installed, authenticated,
or able to return host-MCP calls on a particular Windows endpoint.
Each identity keeps that environment's HOME, PATH, and provider auth files. If the same machine
has two separate accounts for the same provider, separate connection presets
keep those auth contexts from being silently mixed. A preset is not a ShellX
model selector: the `task_provider_catalog` Tauri projection and authenticated
`POST /tasks/provider-catalog` Debug API projection preserve provider-default
model mode and an empty model list until a provider-native structured model
enumeration exists. The bounded Task API manages definitions, state, explicit
attention acknowledgements, exact-revision manual queueing, and exact-attempt
cancellation. Queue acceptance is durable but asynchronous: the one app-owned
foreground runtime resolves the current saved target, performs a fresh provider
scan, and persists each fallback/lifecycle transition before provider effects.
It also revalidates immutable Browser workflow references against the current
saved bookmark and recipe-export digest, and resolves only Vault key/grant
metadata. Host-tool-incompatible providers are skipped before effect; recipe
paths and raw Vault values are not copied into provider prompts or Task
receipts. Explicitly selected host files inside the user home boundary or exact
selected Local/WSL working folder become
content-addressed copies under the exact execution working folder across
Local, WSL, and the three SSH runtime modes.
The private Task ledger binds ID, digest, target, bounded relative path, size,
and a hash-linked persistence receipt; original source paths and bytes remain
outside the store and UI. Execution re-reads the copy before provider dispatch
and stops with typed attention on missing, mismatched, or oversized bindings.
Never-saved imports use a two-phase ledger lifecycle: durable
`reclaimPending`, exact copy verification/removal on the recorded target and
working folder, then durable `reclaimed`. Every immutable saved revision blocks
reclamation; target loss, changed bytes, links, and reparse points stay pending
for an honest retry. One serialized attachment-I/O gate prevents import,
explicit reclamation, and startup maintenance from racing. Each installed boot
retries a bounded pending/stale batch; an unreferenced import becomes stale
only after 24 hours.
Browser Teach reaches that binding through a separate operator-only boundary:
the exact current revision, approval/export receipts, and zero-skip rehearsal
create one idempotent workflow bookmark. A path-free acknowledged window event
is rebound in the main workspace to the exact native receipt, owning Browser
task, and durable workflow bookmark before Task Manager opens against the exact
originating ShellX tab. It never falls back to the active tab, auto-selects a
provider, saves a definition, or enables a schedule. Task Manager projects only
active all-agent mediated Vault grant metadata for the user to bind.
Separately, an agent launched inside ShellX can create a plain Task from explicit
natural-language authorization through the write-class `task_manage` Host tool.
The authenticated caller tab, not agent-supplied target data, selects the saved
connection, working folder, permissions and tool exposure. A fresh target-bound
provider scan authorizes the ordered workers before the definition is written.
The header Tasks panel then becomes the compact review, control and receipt
surface; the full definition form stays behind Edit details. This bridge never
imports attachments, binds Vault grants or reuses a Browser Teach workflow by
guessing their identities.
For a terminal revision that binds a reviewed Browser workflow, the same
deterministic provider-tab identity scopes post-run evidence collection. ShellX
exports bounded Flight Recorder artifacts for only those Browser tasks and
appends a hash-linked, path-free Task result receipt with attempt/report IDs,
artifact digests, completeness, and the exact source terminal receipt identity.
Existing evaluation reports may contribute their identities; the collector does
not create an evaluation or retain page/provider content. Ordinary Tasks do not
enter this Browser evidence path. Startup and foreground polls retry a bounded
set of workflow runs that became terminal before their result receipt was
persisted, closing the post-terminal crash window without rerunning a provider.
The exact result receipt also has a per-occurrence durable index, so later
retention trimming of the general receipt tail neither hides the result from
Task Manager nor triggers a duplicate export.
Each claimed Task attempt also owns a deterministic `task-run-*` runtime tab
and matching private ShellX session JSONL. The app writes the reviewed
instruction before dispatch and routes only that tab's ordinary provider events
through a bounded dedicated writer. This preserves a review surface without
placing provider output in the Task store. After the terminal occurrence, a
detached `shellx.task-trace-evidence.v1` receipt binds the archive's full-file
digest, bounded counts, terminal marker, format/drop state, recovery state, and
source terminal receipt. The exact terminal transition has its own
per-occurrence durable index, so even a one-entry journal retention policy
cannot evict the authority needed by later Trace or Browser evidence. The
renderer recognizes backend-owned Task tabs and
refuses to create a duplicate archive; the run projection exposes an `Open run`
session identity only when Trace evidence proves that the private archive is
reviewable. A recovery receipt remains conservative about completeness.
Its catalogue output deliberately omits binary paths, raw probe diagnostics,
provider-controlled version text, and authentication material; it retains only
one strictly isolated semantic-version token when the checked provider output
contains one. Host MCP exposes only the narrow write-class `task_manage`
creation bridge; execution still reuses the normal provider sessions rather
than introducing a second provider runtime.

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
  so grok can self-introspect (#302). Reqwest redirects are disabled;
  callers must submit the redirect target as a fresh request so ShellX can
  validate its host and resolved addresses independently.
- **`vision_describe`:** xAI Grok multimodal vision. Uses Grok OAuth
  from `~/.grok/auth.json` by default, then falls back to
  `GROK_VISION_API_KEY` / `XAI_API_KEY`, vault `xai/api-key`, and
  pass-store keys. 20 MiB image cap. POSIX paths auto-translate to
  `\\wsl$\<distro>\…` on Windows.
- **`Agent` (subagent fan-out):** `subagent::spawn_subagent` with
  `ledger_dir` path validation, a five-minute default attached wait budget,
  a ten-minute default detached watchdog, caller-overridable timing, and a
  six-concurrent cap (`SHELLX_MAX_SUBAGENTS` override). Credential-shaped task
  text is scrubbed before display.
- **Credential redaction:** every `mcp-events.jsonl` line goes
  through `redact_if_credential_pattern` (21+ patterns:
  `Bearer …`, `ghp_…`, `xai-…`, `sk-…`, `ya29.…`, etc.).

### 4. ACP wire to grok (`acp.rs`)

JSON-RPC over stdio between shellX and the grok-build child. Bi-
directional — shellX sends `session/prompt`, grok sends
`session/update`, `session/request_permission`, `terminal/*`,
`fs/*`, `_x.ai/*` notifications.

Current Grok Build sessions negotiate in the order `initialize` →
`authenticate` → `session/new` or `session/load`. ShellX selects only an
advertised non-interactive method (`xai.api_key` or `cached_token`) and sends
`_meta.headless: true`; it never starts the interactive `grok.com` browser flow
inside the ACP pipe. Long-lived children also receive `--no-auto-update`, so
provider discovery remains the single version-refresh authority for a launch.

**What we trust from grok:** method names (explicit match, unknown
methods get -32601), JSON-RPC param shapes (defensively parsed
with `.and_then`/`.unwrap_or`).

**What we DON'T trust from grok:**
- **Raw shell strings.** Every provider-originated `terminal/*` method is
  intercepted by one transport-neutral boundary and rejected with JSON-RPC
  `-32601` plus guidance to use the supervised ShellX `Agent` tool. No host
  PTY is ever spawned in response to a provider request. This is the
  load-bearing safety property; a regression here would let a provider run
  arbitrary shell. See `acp.rs::reject_provider_terminal_method`.
- **Cwd/paths.** Every path arriving over ACP goes through
  `validate_fs_path` on the way to `fs_*` tools.

**Trust we DO give the operator:** SSH host/port/key_vault_ref/
remote_grok_path come from `connections.json`, written by the user
via the UI. SSH destinations are validated with
`acp.rs::validate_ssh_destination_arg`; command fragments use
`acp.rs::shell_quote_for_remote` for POSIX or encoded PowerShell with quoted
argument arrays for native Windows, with operator-owned connection fields kept
inside that connection preset boundary.

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

- [`docs/public/API.md`](API.md) — the shellXagent JSON-RPC over HTTP+WS
  endpoint inventory + curl recipes.
- [`docs/public/THREAT_MODEL.md`](THREAT_MODEL.md) — single-user posture +
  trust surface enumeration.

## Module map (Rust, `src-tauri/src/`)

The Browser and Vault surfaces are intentionally split into focused modules.
Browser tab handoff is an operator-only Tauri path: the review sheet captures
an opaque SHA-256 fingerprint over the exact page, profile, user ownership, and
target task. `shellx_browser_tab_handoff.rs` recomputes it while holding the
Browser state lock and changes ownership only after an exact match, so the UI
review and backend mutation share one fail-closed state identity.
`lib.rs` and `App.tsx` are still large legacy coordination points, not preferred
module sizes. `host_mcp.rs` is now a thin MCP wire and dispatch root whose domain
behavior lives under `host_mcp/`. `debug_api.rs` keeps the authenticated server,
shared state model, and route composition while domain handlers live in focused
`debug_api_*.rs` modules. Browser and Vault domain code is organized in focused
module families; the private engineering rules define contribution placement
and source-size maintenance policy.
The vendored Vault boundary carries `vendor/shellx-vault/PROVENANCE.json`, which
binds the full standalone upstream Git revision to deterministic SHA-256 source
digests for each included crate. Public CI recalculates those digests from the
checkout, so provenance verification does not depend on a sibling Vault clone.
The Linux GTK3 boundary resolves `glib 0.18.5` through `vendor/glib` because the
current Tauri/WebKitGTK graph still requires the gtk-rs 0.18 API. `UPSTREAM`
records the published crate digest and the reviewed gtk-rs `VariantStrIter`
soundness backport.

| File | LOC | Role |
|---|---|---|
| `host_mcp.rs` | ~1.3k | Host MCP wire protocol, dispatcher, redaction, and audit coordination; schemas and domain tools live under `host_mcp/` |
| `debug_api.rs` | ~2.0k | shellXagent auth/origin gates, shared state, route table, descriptor and agent-doc serving; domain handlers live in `debug_api_*.rs` |
| `lib.rs` | ~7.6k | Tauri setup, IPC command registration, session lifecycle, provider/host MCP injection |
| `acp.rs` | ~7.8k | ACP wire to Grok, SessionRegistry, terminal/* intercept, per-transport spawn |
| `shellx_browser.rs` | ~0.3k | Browser facade, shared registry state, constants, and domain re-exports |
| `shellx_browser_registry_policy.rs` / `shellx_browser_registry_actions.rs` | ~1.3k | Registry construction/persistence and action dispatch policy |
| `shellx_browser_window_open_runtime.rs` / `shellx_browser_engine_runtime.rs` | ~1.6k | Top-level Browser chrome lifecycle, bounded/late opener reconciliation, and transactional child-WebView engine mounting |
| `shellx_browser_window_runtime.rs` / `shellx_browser_dialog_runtime.rs` | ~0.5k | Tauri Browser command boundary and task-owned dialog resolution |
| `shellx_browser_tab_handoff.rs` | ~0.3k | Backend-validated Browser page/profile/ownership/task review binding and atomic handoff |
| `shellx_browser_flight_recorder.rs` / `shellx_browser_flight_recorder_sanitization.rs` | ~1.2k | Flight Recorder selection/artifact orchestration plus its bounded redaction and loss-accounting boundary |
| `shellx_browser_state_helpers.rs` / `shellx_browser_network_receipts.rs` | ~0.7k | State synchronization plus bounded network/receipt mutation |
| `shellx_browser_tests/` | ~3.0k | Browser registry behavior tests split by action, engine, tab/pool, and dialog ownership |
| `shellx_browser_model.rs` | ~0.9k | Browser data model, receipts, transfers, policies, serialized state shapes |
| `shellx_browser_actions.rs` / `shellx_browser_action_results.rs` | ~2.5k | Engine action execution, actionability, step summaries, redaction-safe result shaping |
| `shellx_browser_prompt_guard.rs` | ~0.8k | Fixed-vocabulary pre-action prompt-injection classification, sanitized receipts, unavailable fail-closed policy, and one-shot operator override binding |
| `shellx_browser_recipes.rs` / `shellx_browser_recipe_analysis.rs` | ~1.2k | Recipe export/replay contracts plus variable, assertion, and decision-point analysis |
| `debug_api_browser_recipe_replay.rs` / `shellx_browser_robots.rs` | ~0.6k | Live recipe execution, navigation settlement, and truthful robot lifecycle outcomes |
| `shellx_browser_bookmarks.rs` | ~830 | Bookmark/folder tree, toolbar, workflow bookmark metadata |
| `shellx_browser_*` smaller modules | varies | Shields, personal lock, developer mode, scripts, engine runtime/state, transfers, tabs, tasks, Vault, session grants |
| `shellx_vault/backend.rs` | ~3.6k | ShellX Vault setup/unlock/resources, legacy import, broker adapter, UI/Debug API bridge |
| `shellx_vault/grants.rs` / `recovery.rs` | small | ShellX grant/recovery helpers around the shared broker |
| `vendor/shellx-vault/crates/vault-broker/` | varies | Shared Vault broker resources, grants, receipts, project capsules, safe folders, backups, sync sets |
| `mcp_http.rs` | ~2.3k | Streamable HTTP MCP server, origin allow-list, token and tab-bound-token gates |
| `skill_install.rs` | ~1.8k | Bundled `shellx-host` install to Grok/Codex/Claude and ShellX-owned agent-doc paths |
| `provider_sessions.rs` | ~5.2k | Codex/Claude/Antigravity process launch, resume ids, stream normalization |
| `subagent.rs` | ~3.2k | `Agent` fan-out: spawn, registry, ledger, output capture |
| `session_archive.rs` | ~1.0k | Local zip + SSH tar.gz streaming archive |
| `mcp_marketplace.rs` | ~1.7k | Marketplace state, catalog, install/enable plumbing |
| `process_registry.rs` | ~0.9k | Tracks shellX-spawned child processes for `process_signal` |

Frontend lives under `src/`. Entry is `src/App.tsx`; settings under
`src/components/settings/`; Browser chrome is under `src/browser/` and
`src/browser/components/`; the chat surface is
`src/components/ChatOutput.tsx`.
