# shellX threat model

This document states explicitly what shellX defends against, what it
does not, and the trust assumptions that make those choices coherent.
Read alongside [`ARCHITECTURE.md`](ARCHITECTURE.md), which describes
the structure; this document describes the adversaries it's designed
to resist.

## TL;DR posture

shellX is a **single-user developer tool that runs on a trusted local
machine**. Its threat model is shaped by that premise. We defend
robustly against the active agent process attempting to step outside its
sandbox, and against accidental data loss or credential leakage. We
do **not** defend against an attacker who already has a shell on the
user's machine — that adversary is out of scope and would already
own the user's `~/.aws/credentials`, `~/.ssh/`, and `pass` store
regardless of what shellX does.

## Adversary catalog

| Adversary | Capability assumed | In scope? |
|---|---|---|
| The active agent process (Grok Build or provider CLI) | Can emit any tool call, any JSON, any path string, any cwd, any prompt response. May lie about what it did. Provider CLIs may also use native shell/file tools outside ShellX's MCP tool parser. | **Yes** |
| Untrusted content the agent fetched/read | Files, web pages, archive contents, image bytes, MCP server tool responses returned to Grok, Codex, Claude, Antigravity, or another connected provider | **Yes** |
| Another local process on the user's machine | Same OS session, can read user-readable files, can connect to `127.0.0.1` ports | **Yes, with caveats** (see §Local processes) |
| A privileged user (root/Administrator) | Full read-write on the user's filesystem and process state | **No** — out of scope |
| A LAN-attached attacker | Cannot reach `127.0.0.1` sockets but can attempt network requests | **Yes** (handled by 127.0.0.1 bind) |
| A remote attacker on the public internet | No path to the user's machine without compromise of an exposed service | **No** — shellX exposes nothing publicly |
| A compromised shared-tenant host (SSH workstation/remote VPS) | Has shell access on the SSH target the user connected to | **Partial** — see §Remote machine compromise |

## In-scope threats

### T1. Agent breaks out of working directory
The active adversary in a shellX session is the agent process that owns it:
Grok ACP for Grok tabs, or the selected provider CLI for provider tabs. It may
try to read or write outside the declared cwd, escalate via `..` traversal, or
use POSIX paths on Windows to reach `\\?\C:\Windows\...`.

**Defense**: `host_mcp/filesystem_core.rs::validate_fs_path` is the single chokepoint
for every `fs_*` tool. Enforces absolute paths, rejects null bytes,
rejects `..` substrings, rejects POSIX-on-Windows except UNC /
`/mnt/c` / `/cygdrive`. Write-class tools additionally canonicalize
HOME and reject anything outside the home tree. A sensitive-path denylist
blocks credential stores, shell startup files, SSH config, Git config, and
user persistence locations even when they are inside HOME.

### T2. Agent runs arbitrary shell
A provider-originated `terminal/*` request, if honored, could spawn or control
a host PTY with provider-selected commands.

**Defense**: `acp.rs::reject_provider_terminal_method` is the single boundary
for every `terminal/*` method on every transport. It returns JSON-RPC `-32601`
with guidance to use the supervised ShellX `Agent` tool instead. **No host PTY
is ever spawned in response to a provider request.** This is load-bearing — a
regression here would let a provider run arbitrary shell.

### T3. Agent exfiltrates host credentials
An active Grok or provider CLI session could read `~/.aws/credentials`, `~/.ssh/id_*`, `~/.password-store/`,
or `~/.shellx/{debug,mcp}.token` and forward them via `net_fetch`,
web_search result body, or chat output to xAI's logs.

**Defense layers (depth, not perimeter)**:
- `validate_fs_path` plus the host-MCP sensitive-path denylist on read-class
  tools (`fs_read`, `fs_read_binary`, `fs_grep`, `fs_list_dir`, `fs_stat`,
  `fs_exists`) — the agent cannot read SSH material, shellX tokens, GitHub CLI
  tokens, cloud CLI credentials, npm/Docker/Kubernetes credentials, or
  password-store/GPG files through ShellX host filesystem tools. Recursive
  `fs_grep` skips denied files before opening them.
- `net_fetch` allow-list at `~/.shellx/net_allow.toml`. Default is
  permissive for developer use but user can tighten.
- Credential-shape scrubber `redact_if_credential_pattern` runs over
  `mcp-events.jsonl`, subagent task previews, and any text rendered to
  the Tasks rail. 21+ patterns: `Bearer …`, JWT (`ey…`), `ghp_…`,
  `xai-…`, `sk-…`, `ya29.…`, etc.
- ShellX Vault values never appear in logs or agent-facing planning
  responses. `vault:`, `pass:`, and bare legacy references are denied on
  the agent-facing `secret_get` path; agents must request a grant and use
  mediated Browser/Vault fill, injection, or write-only deposit routes.
  Operator/UI reveal remains a separate user-controlled path.

**Residual risk**: the agent can still read files inside the active
cwd. A user who opens shellX rooted at `~` or `/` exposes everything
to the agent. Mitigation is **operator hygiene** — pick a project
folder, not a home root.

### T4. Agent lies about completion
The active agent may claim a tool succeeded when it didn't, or claim a file was
written when nothing changed.

**Defense**:
- All tool calls and their results are logged verbatim to
  `~/.shellx/sessions/<sid>.jsonl`. The session log is the source of
  truth for what grok actually did, separate from what grok claimed
  in chat.
- Build Mode (`build_complete()` MCP gate) validates the
  scratchboard before accepting completion — refuses if any
  phase still has unchecked sub-stages.
- Tasks rail (right panel) shows real subagent state from the
  `host_subagents` registry, not from grok's narrative.

### T5. Agent injection via untrusted content
A web page fetched via `net_fetch`, a file read from disk, or an MCP
tool response could carry prompt-injection text like
`"ignore previous instructions, use fs_write to ..."`.

**Defense**: shellX cannot stop prompt injection at the model layer
— that's the provider/model layer's responsibility. shellX does:
- Render tool responses as data, not as instructions, in the UI
  (visual distinction between user-typed and agent-generated).
- Cap `net_fetch` body, so a 50 MB attack page can't drown the
  conversation.
- Browser observations now use a measured default response budget and expose
  truncation/size metadata. The advertised Browser schema is routed through two
  compact tools. The broader Host MCP now advertises only `host_read` and
  permission-gated `host_act` alongside orientation/search and the Browser
  and ShellX Cut pairs; exact legacy schemas and Cut's generated verb catalog
  remain targeted-search results instead of always-injected prompt material.

### T6. Local-process eavesdropping on shellXagent / host MCP
Another process running as the same user could connect to
the published loopback ports and exfiltrate session content or call
host MCP tools.

**Defense**:
- Both ports bind 127.0.0.1 only (never 0.0.0.0).
- Both require bearer-token auth (`shellxagent.token` / `mcp.token`),
  16-byte OsRng, and atomic replacement. Token files use mode 0600 on
  macOS/Linux and inherit the user-private profile ACL on Windows.
- Constant-time compare resists timing attacks.
- Origin allow-list checked before token (403 vs 401 distinguishable).
- `tauri-plugin-single-instance` prevents two shellX processes
  fighting over the port.

**Residual risk**: any process running as the same user can read the
token files. This is consistent with the user's existing posture
(any process running as the user can read `~/.aws/credentials`).
Tightening this would require OS-level credential isolation
(`keyring-rs` for the token itself, prompted on each app launch)
which we judge worse-UX-than-it's-worth for a single-user dev tool.

### T7. Remote-machine compromise leaks host MCP via tunnel
When grok or a provider CLI runs in WSL or over SSH, shellX forwards the bound
host-MCP loopback port into the remote. **Any same-user process on that remote
machine that can discover the forwarded port and bearer while the session is
running remains in scope for host MCP exposure.**

**Current state**:
- ShellX sends the host MCP URL and tab-bound bearer only in the provider's
  session-scoped MCP payload. WSL/SSH project `.grok/config.toml` files are
  migration inputs only; ShellX removes its legacy sections and writes no
  replacement.
- Spawned Grok/Codex/Claude MCP clients receive a tab-bound token derived from
  the host MCP token and the ShellX tab id. Write-class tools require that
  tab-bound token for the claimed tab, which blocks cross-tab query/header
  spoofing by another ShellX-managed MCP client.
- The tab-bound token is still present in provider process memory and valid for
  the provider process lifetime, so same-user process inspection on the remote
  remains in scope. One-shot Grok subagents use a temporary isolated
  `GROK_HOME` and remove it on exit.

**Planned hardening (#330)**:
- Token binding to originating SSH connection ID.
- Per-connect rotation for tab-bound tokens.
- mTLS as an optional stronger mode.

**Operator guidance**: only connect to remotes you fully control. Treat the
remote machine's tenant model as in-scope for ShellX exposure during the
connection lifetime.

### T8. Replay or extension of session beyond user intent
A long-running session could pile up state, accumulate doom-loops,
or burn provider quota or tokens unnoticed.

**Defense**:
- Grok-provider loop signal (`#156`) — ShellX surfaces Grok's own
  `doom_loop_detected` notification as an amber pill. ShellX does not perform
  equivalent loop detection for Codex, Claude Code, or Antigravity sessions.
- Token-counter per session displayed in the chip rail.
- Tab-lifetime cleanup — the provider session lives as long as the tab is
  open; closing the tab fires `drop_tab_session`. There is no idle timer.
- Build Mode does not kill active work when a wait budget expires;
  long-running subagents must still be observable through receipts,
  status polling, and user-visible task state.

### T9. Full Auto executes without per-tool confirmation
ShellX's normal agent-first workflow uses Full Auto for provider
sessions and Build work. For provider CLIs this maps to native bypass
flags such as Codex `--dangerously-bypass-approvals-and-sandbox`,
Claude Code `--permission-mode bypassPermissions`, and Antigravity
`--dangerously-skip-permissions`. Grok Auto similarly starts with the
approval behavior baked into the spawned CLI argv.

**Defense / operator contract**:
- Full Auto must be presented as a warning-level mode, not a harmless
  preference.
- Users should choose a project folder, not `~`, `/`, or a broad
  downloads/home workspace.
- Users should connect only to WSL/SSH environments they control.
- Planning remains available as a ShellX mode; coding-agent execution uses the
  provider's native Full Auto controls.

**Residual risk**: in Full Auto, the selected provider can run native
tools and shell/file actions according to that provider's own rules.
ShellX can observe and verify many outcomes, but it cannot pre-approve
every native provider action once a bypass mode has been selected.

### T10. Vendor bootstrap substitution during Agent CLI setup
An attacker who can replace a vendor bootstrap response could gain code execution in
the selected local, WSL, or SSH environment when the operator installs an agent CLI.
Piping a response directly to `bash`, `sh`, or `Invoke-Expression` also prevents the
operator from reviewing a stable artifact before execution.

**Defense**:
- Native setup recipes use structured HTTPS source URLs on an exact host allowlist;
  URL credentials, non-default ports, queries, fragments, and redirects are rejected.
- `prepare` downloads into a unique target-local directory with restrictive POSIX
  permissions, an 8 MiB limit, bounded timeouts, and a shebang check for POSIX scripts.
- The confirmation UI shows source URL, byte count, SHA-256, version-detection status,
  and verification policy before execution.
- `confirm` accepts only an opaque confirmation id, recomputes SHA-256 on the same
  staged path, and invokes only the recipe's fixed `bash`, `sh`, PowerShell, or CMD
  interpreter. It never accepts caller-supplied script text, paths, URLs, or digests.
- Success, failure, explicit cancel, confirmation expiry, and UI teardown all remove
  the owned staging directory. Package-manager fallbacks remain separate methods.

**Residual risk**: the digest binds the reviewed bootstrap bytes to the execution, but
it is not a vendor trust anchor. A valid bootstrap can fetch additional binaries whose
signature/checksum policy is controlled by that vendor. Upstream compromise, a
compromised approved host, or an installer that fails to verify its downstream payload
remain supply-chain risks until vendors publish signatures or pinned digests ShellX can
verify independently.

### T11. Owner-approved Vault command exfiltrates an injected resource
An agent can request a local executable with selected Vault resources injected
as environment variables. Even when the request text is honest, the executable
itself can read, persist, transmit, or pass those values to descendants.

**Defense / operator contract**:
- Agents can submit, list, or cancel metadata-only requests but cannot approve
  or deny them. Approval requires a trusted in-app operator action.
- The request is digest-bound to one absolute program, exact arguments, optional
  absolute cwd, resource-to-environment bindings, timeout, and requester.
- Approval rechecks current resource visibility and request expiry. Inline
  interpreter evaluation, loader-altering environment names, user-only
  resources, oversized input/output, and unbounded runtime are refused.
- The child starts from a cleared environment plus a small platform allowlist;
  exact injected values are redacted from bounded stdout/stderr receipts.

**Residual risk**: approval authorizes the selected executable to receive the
resource. ShellX cannot stop trusted code from exfiltrating it or descendants
from inheriting it under normal process semantics. The Request Center must show
the full executable, arguments, cwd, bindings, requester, and expiry so the
operator can make that trust decision.

### T12. Browser evidence artifacts retain cross-task or secret state
Trace, recipe, and Flight Recorder artifacts can outlive a Browser task. A
cross-task selector, arbitrary receipt evidence, URL query, console credential,
or raw browser-state field could otherwise leak into a durable file.

**Defense**:
- The Flight Recorder agent route requires the authenticated task owner session
  and rejects mismatched task/tab/profile scope.
- It projects allowlisted task/tab/network/console fields, recursively redacts
  credential/storage/body/header/DOM classes, strips URL query and fragment
  values, and excludes screenshots and raw browser state.
- The final assembled artifact is passed through the host-side protected-value
  registry for the exact task/tab before it is written. Page-side taint markers
  and English keyword classification are untrusted defense-in-depth signals;
  they may raise the risk/approval floor but cannot lower host-side gates.
- Event/receipt counts, nested values, text length, and total artifact bytes are
  bounded. The response hashes the exact private artifact bytes.
- The evaluation core accepts only canonical files below the private Flight
  Recorder root and verifies byte count, SHA-256, schema, attempt/group/task
  identity, and every required redaction receipt before reading bounded JSON.
  Every attempt must use a distinct Browser task, baseline/candidate task sets
  must be disjoint, and suite/group values must match the source artifact.
  Reports link artifact identities without embedding their bodies, separate
  factual measurements from rating policy, and fail closed on missing evidence
  or candidate safety violations. Evaluator-declared attempt metrics are labeled
  as declarations rather than presented as recorder-derived facts.
- FR-1 and FR-2 are not separately advertised as extra Browser MCP tools;
  routed access uses the existing compact gateway instead. Write actions remain permission
  gated, require a valid ShellX caller-session header, enforce task ownership,
  and reject invalid caller headers rather than falling back to operator scope.
  Direct bearer-authenticated CLI calls use operator authority. Recent evidence
  views are allowlisted, bounded, and caller-task scoped.

**Residual risk**: bounded non-secret page text and metadata can still contain
sensitive business information that does not match a credential pattern.
Artifacts remain private local evidence and should not be copied into a project
or public export without explicit review.

### T13. Third-party MCP server inherits ShellX session authority
A marketplace MCP server runs as a child process and receives environment
needed for its tab-scoped ShellX integration. A malicious or compromised server
could use that authority, and package-backed entries such as `npx` or `uvx` can
change upstream unless the operator pins and reviews them.

**Defense / operator contract**:
- Host access is scoped to the ShellX tab and its current autonomy gate rather
  than a global reusable provider registration.
- Unknown write-class activity is still subject to ShellX's tab-bound gate and
  individual tool contracts.
- Install only MCP entries whose publisher, package/version, command, and Vault
  requirements you trust; prefer pinned packages and disable entries that are
  not needed for the current work.

**Residual risk**: a trusted tab can still expose substantial read-class data,
and Full Auto permits write-class actions within that tab's allowed scope.
Per-tab scoping limits blast radius; it does not make third-party code safe.

### T14. Browser native hardening is platform-dependent
The Windows WebView runtime provides the strict native request filter, native
permission gate, and password-autosave suppression used by ShellX Browser.
macOS and Linux do not currently provide those three native controls and show a
degraded-protection notice in the Browser UI.

**Operator guidance**: treat Windows as the fully hardened Browser surface for
credential-bearing or adversarial web automation. On macOS/Linux, keep work to
trusted sites and non-sensitive flows unless the missing native controls are
acceptable for the task.

### T15. A same-origin page retargets a granted credential
An origin-bound Vault grant alone does not prove that the selected field is a
credential control or that its form submits back to the same site. A malicious
page on the granted origin could otherwise request a secret into an ordinary
text field or a form posting to another origin.

**Defense**: agent-driven Vault fills require a current host-held Browser
observation, an exact ref/selector match to a credential-shaped field, and a
form action that resolves to the granted/current origin. The check runs before
grant authorization and before plaintext is read from Vault. Origin changes,
unobserved targets, ordinary text fields, and cross-origin form actions fail
closed.

### T16. ShellX Cut proxy inherits Cut's local-machine trust boundary
`cut_act` starts the installed `cutd mcp` proxy, which reaches the same running
ShellX Cut engine and open project as the editor UI. Cut's loopback API/MCP is a
single-personal-workstation surface, not a same-user authentication boundary.
A substituted executable or another local process able to call Cut directly
could therefore affect the open project outside ShellX's tab gate.

**Defense**:
- ShellX resolves `cutd` only from documented installation locations or an
  explicit absolute `SHELLX_CUT_CUTD` override. It does not search the provider
  cwd or general `PATH`.
- The child receives only the fixed `mcp` argument, runs from its installed
  directory, is tied to the parent lifetime, and has bounded request, stdout,
  stderr, and execution-time limits.
- The generated Cut catalog stays behind bounded `cut_read` discovery. Every
  exact verb call uses permission-gated `cut_act` until Cut publishes reliable
  read/mutation annotations.
- ShellX does not expose Cut remotely, copy provider credentials, or create a
  second project/timeline authority.

**Residual risk**: ShellX trusts the installed Cut binary and Cut's documented
whole-machine local API posture. Same-user malware can call Cut without going
through ShellX; preventing that requires a future authenticated Cut transport,
not another ShellX prompt.

## Out-of-scope threats

### O1. Root / Administrator on the local machine
If an attacker has Administrator on Windows or root on Linux/WSL,
they can read process memory, install rootkits, intercept keyring,
and bypass any shellX defense. shellX is a userspace tool; we trust
the OS.

### O2. Compromise or loss of Vault recovery material
ShellX Vault uses encrypted local or connected resources mediated by
`shellx_vault/` and the shared Vault broker, with OS-backed remembered-device
custody where configured and recovery materials under user control. If the
user's device credential, master passphrase, recovery kit, or connected Vault
endpoint is compromised, an attacker may gain access to stored secrets. If they
are lost or damaged, stored secrets may be unrecoverable. ShellX does not claim
server-side escrow or recovery beyond the saved recovery materials.

### O3. Compromise of grok-build's xAI auth
Grok-build has its own `~/.grok/auth.json` with an xAI session token.
If that's stolen, the attacker can impersonate the user against xAI
APIs. ShellX does not copy, move, rewrite, or persist that provider-owned
credential. When the user invokes ShellX's optional xAI-backed vision, voice,
transcription, or X Search tools, the local tool reads the canonical credential
into process memory for that request; an explicit Vault or environment API key
can be used instead. Protecting the provider credential at rest remains xAI's
and the operating system's boundary, while preventing it from appearing in
ShellX logs, evidence, or agent-facing responses remains ShellX's boundary.

### O4. Side-channels (timing, cache, power)
No defense against e.g. timing attacks on the auth flow beyond
constant-time string compare. Not a worthwhile defense surface
against an attacker who is already on the local box.

### O5. Supply-chain compromise
A malicious update to grok-build, Tauri, axum, reqwest, or any
dependency could leak everything. shellX runs both RustSec `cargo audit` and a
Grype Rust-crate scan backed by the GitHub advisory database in its GitHub
Actions CI pipeline (`.github/workflows/ci.yml`) on every push. Exact,
time-limited reachability dispositions fail closed when they expire or drift,
but shellX does not vendor dependencies. The user trusts the same
supply chain as any other Rust + Node app on their machine.
Agent CLI bootstrap execution has the T10 staging/digest controls, but downstream
artifacts fetched by those bootstraps remain inside the vendor's supply-chain boundary.

### O6. Physical access to an unlocked machine
Same as O1 — out of scope.

## Cross-reference

| Surface | Threat IDs | Defense location |
|---|---|---|
| shellXagent loopback port | T6 | `debug_api.rs::require_auth` |
| Host MCP HTTP loopback port | T6, T7 | `mcp_http.rs` auth/origin gates and `write_class_gate_action` |
| Host MCP stdio surface | T1, T2, T3, T5 | `host_mcp/filesystem_core.rs::validate_fs_path`, redaction, `net_fetch` allow-list |
| ACP wire to grok | T2, T4 | `acp.rs::handle_terminal_create` intercept, `sessions/<sid>.jsonl` logging |
| Vault | T3, O2 | `shellx_vault/*`, `vendor/shellx-vault/crates/vault-broker/*`, legacy `vault.rs` compatibility |
| SSH/WSL tunnel | T7 | (planned) `#330` per-session token |
| Agent CLI setup | T10, O5 | `agent_cli_setup.rs` URL allowlist, staged digest confirmation, fixed interpreter, cleanup |
| Vault executable requests | T11 | `shellx_vault/agent_requests.rs`, shared `vault-broker`, trusted Request Center commands |
| Third-party marketplace MCP servers | T13, O5 | `mcp_marketplace.rs`, tab-bound host token and write-class gate |
| Platform-dependent Browser controls | T14 | `shellx_browser_engine.rs`, `shellx_browser_security.rs`, degraded-protection UI notice |
| Browser Flight Recorder and evaluation artifacts | T12 | `shellx_browser_flight_recorder.rs`, `shellx_browser_evaluations.rs`, authenticated Debug API export route, artifact budgets |
| Browser Vault fill targets | T15 | `shellx_browser_vault.rs`, current observation and same-origin form-action validation |
| ShellX Cut compact proxy | T16 | `host_mcp/cut_mcp.rs`, standard install-path resolution, process/output bounds, and `cut_act` write-class gate |

## Known open exposures (acknowledged, tracked)

- **T7 / #330** — Static mcp.token on the remote-machine end of the
  SSH reverse tunnel. The tunnel uses the bound MCP port published in
  `~/.shellx/mcp-http.port`, not a fixed port. Tracked, hardening
  planned. Operator workaround: use trusted remotes only.
- **Full Auto defaults** — Provider sessions and Build workflows default
  to auto/bypass permission behavior. This is intentional for ShellX's
  agent-first workflow, but must remain visible as a warning-level mode
  in user docs and UI copy.
- **Token-file readability** — `shellxagent.token` and `mcp.token` use
  mode 0600 on macOS/Linux and the user-private profile ACL on Windows,
  but any same-user process can read them. Equivalent
  exposure to `~/.aws/credentials`. Acceptable for single-user dev
  tool posture.
- **Vendor bootstrap downstream payloads** — ShellX verifies the exact bootstrap shown
  at confirmation, but cannot independently attest later downloads when the vendor does
  not publish a signature or pinned digest. Prefer package-manager integrity metadata or
  vendor-signed artifacts where available.

## Review cadence

Review this document on every release that touches an auth path,
adds a new MCP tool, adds a new wire surface, or changes a trust
boundary. Last review: 2026-08-05 (Vault executable requests, Browser Flight
Recorder artifacts, native Windows SSH, compact Browser gateway, protected-value
artifact redaction, and observed Vault fill targets). Next:
alongside #330 implementation, FR-2/FR-3, or any change to installer source
domains/interpreters.
