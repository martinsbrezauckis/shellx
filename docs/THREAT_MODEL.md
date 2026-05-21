# shellX threat model

This document states explicitly what shellX defends against, what it
does not, and the trust assumptions that make those choices coherent.
Read alongside [`ARCHITECTURE.md`](ARCHITECTURE.md), which describes
the structure; this document describes the adversaries it's designed
to resist.

## TL;DR posture

shellX is a **single-user developer tool that runs on a trusted local
machine**. Its threat model is shaped by that premise. We defend
robustly against the agent (grok) attempting to step outside its
sandbox, and against accidental data loss or credential leakage. We
do **not** defend against an attacker who already has a shell on the
user's machine — that adversary is out of scope and would already
own the user's `~/.aws/credentials`, `~/.ssh/`, and `pass` store
regardless of what shellX does.

## Adversary catalog

| Adversary | Capability assumed | In scope? |
|---|---|---|
| The hosted agent (grok-build) | Can emit any tool call, any JSON, any path string, any cwd, any prompt response. May lie about what it did. | **Yes** |
| Untrusted content the agent fetched/read | Files, web pages, archive contents, image bytes, MCP server tool responses returned to grok | **Yes** |
| Another local process on the user's machine | Same OS session, can read user-readable files, can connect to `127.0.0.1` ports | **Yes, with caveats** (see §Local processes) |
| A privileged user (root/Administrator) | Full read-write on the user's filesystem and process state | **No** — out of scope |
| A LAN-attached attacker | Cannot reach `127.0.0.1` sockets but can attempt network requests | **Yes** (handled by 127.0.0.1 bind) |
| A remote attacker on the public internet | No path to the user's machine without compromise of an exposed service | **No** — shellX exposes nothing publicly |
| A compromised shared-tenant host (PC2/remote VPS) | Has shell access on the SSH target the user connected to | **Partial** — see §Remote machine compromise |

## In-scope threats

### T1. Agent breaks out of working directory
The active adversary in every shellX session is grok. It may try to
read or write outside the declared cwd, escalate via `..` traversal,
or use POSIX paths on Windows to reach `\\?\C:\Windows\...`.

**Defense**: `host_mcp::validate_fs_path` is the single chokepoint
for every `fs_*` tool. Enforces absolute paths, rejects null bytes,
rejects `..` substrings, rejects POSIX-on-Windows except UNC /
`/mnt/c` / `/cygdrive`. Write-class tools additionally canonicalize
HOME and reject anything outside the home tree.

### T2. Agent runs arbitrary shell
A `terminal/create` request from grok over ACP, if honored, would
spawn a host PTY with whatever command grok wants.

**Defense**: `acp.rs::handle_terminal_create` intercepts on every
transport. Local Windows redirects to `grok-shell-host__Agent`
(supervised subagent). WSL/SSH return a user-facing error. **No host
PTY is ever spawned in response to a grok request.** This is
load-bearing — a regression here would let grok run arbitrary shell.
See `acp.rs:2604-2632`.

### T3. Agent exfiltrates host credentials
grok could read `~/.aws/credentials`, `~/.ssh/id_*`, `~/.password-store/`,
or `~/.shellx/{debug,mcp}.token` and forward them via `net_fetch`,
web_search result body, or chat output to xAI's logs.

**Defense layers (depth, not perimeter)**:
- `validate_fs_path` HOME-tree restriction on read-class (fs_read,
  fs_read_binary, fs_grep, fs_list_dir, fs_stat, fs_exists) — the
  agent simply can't read `~/.ssh/id_*` or `~/.password-store/.gpg-id`.
- `net_fetch` allow-list at `~/.shellx/net_allow.toml`. Default is
  permissive for developer use but user can tighten.
- Credential-shape scrubber `redact_if_credential_pattern` runs over
  `mcp-events.jsonl`, subagent task previews, and any text rendered to
  the Tasks rail. 21+ patterns: `Bearer …`, JWT (`ey…`), `ghp_…`,
  `xai-…`, `sk-…`, `ya29.…`, etc.
- Vault values never appear in logs; `secret_get` returns the value
  to grok but the value is not echoed in event streams.

**Residual risk**: the agent can still read files inside the active
cwd. A user who opens shellX rooted at `~` or `/` exposes everything
to the agent. Mitigation is **operator hygiene** — pick a project
folder, not a home root.

### T4. Agent lies about completion
grok may claim a tool succeeded when it didn't, or claim a file was
written when nothing changed.

**Defense**:
- All tool calls and their results are logged verbatim to
  `~/.shellx/sessions/<sid>.jsonl`. The session log is the source of
  truth for what grok actually did, separate from what grok claimed
  in chat.
- The Goal-orchestrator (`goal_complete()` MCP gate) validates the
  scratchboard before accepting "GOAL_COMPLETE" — refuses if any
  phase still has unchecked sub-stages.
- Tasks rail (right panel) shows real subagent state from the
  `host_subagents` registry, not from grok's narrative.

### T5. Agent injection via untrusted content
A web page fetched via `net_fetch`, a file read from disk, or an MCP
tool response could carry prompt-injection text like
`"ignore previous instructions, use fs_write to ..."`.

**Defense**: shellX cannot stop prompt injection at the model layer
— that's grok-build's responsibility. shellX does:
- Render tool responses as data, not as instructions, in the UI
  (visual distinction between user-typed and agent-generated).
- Cap `net_fetch` body, so a 50 MB attack page can't drown the
  conversation.
- (Planned #334) When grok 0.1.212+ caps `use_tool` output at 20 KB,
  we'll pre-truncate large host-MCP responses with a `truncated:
  true` envelope so the model sees both signal AND boundary.

### T6. Local-process eavesdropping on shellXagent / host MCP
Another process running as the same user could connect to
the published loopback ports and exfiltrate session content or call
host MCP tools.

**Defense**:
- Both ports bind 127.0.0.1 only (never 0.0.0.0).
- Both require bearer-token auth (`shellxagent.token` / `mcp.token`),
  16-byte OsRng, atomic 0600 file.
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
When grok runs in WSL or over SSH, shellX forwards the bound host-MCP
loopback port into the remote. **Any same-user process on that remote
machine that can discover the forwarded port and bearer while the
session is running can call host MCP tools with that session's
mcp.token.**

This is the open exposure tracked under the `mcp_http` reverse-
tunnel review.

**Current state**:
- mcp.token is the only gate — no per-session rotation.
- shellX writes `bearer_token_env_var = "SHELLX_MCP_TOKEN"` into the
  project `.grok/config.toml`; it no longer writes a literal bearer
  token to that file.
- The token is still present in the spawned grok process environment
  and valid for the lifetime of the shellX process, so same-user
  process inspection on the remote remains in scope.

**Planned hardening (#330)**:
- Per-session token, rotated on each `/connect`, scoped only to that
  session's grok process.
- Token binding to originating SSH connection ID.
- mTLS as an optional stronger mode.

**Operator workaround until #330 lands**: only connect to remotes
you fully control. Treat the remote machine's tenant model as
in-scope for shellX exposure during the connection lifetime.

### T8. Replay or extension of session beyond user intent
A long-running session could pile up state, accumulate doom-loops,
or burn xAI tokens unnoticed.

**Defense**:
- Doom-loop detector (`#156`) — amber pill when grok emits the same
  tool-call N+ times in a row. User dismisses or `/abort`.
- Token-counter per session displayed in the chip rail.
- Idle session timeout — grok session lives as long as the tab is
  open; closing the tab fires `drop_tab_session`.
- Goal-orchestrator adds wallclock cap (6h default) for
  `/goal` mode.

## Out-of-scope threats

### O1. Root / Administrator on the local machine
If an attacker has Administrator on Windows or root on Linux/WSL,
they can read process memory, install rootkits, intercept keyring,
and bypass any shellX defense. shellX is a userspace tool; we trust
the OS.

### O2. Compromise of the user's GPG passphrase / keyring master
The vault (`vault.rs`) uses chacha20poly1305 with a master key
custodied by `keyring-rs` (Windows DPAPI / Linux secret-service /
macOS Keychain). If those custodies are broken, the vault is open.
shellX does not implement defense-in-depth against keyring breakage.

### O3. Compromise of grok-build's xAI auth
Grok-build has its own `~/.grok/auth.json` with an xAI session token.
If that's stolen, the attacker can impersonate the user against xAI
APIs. This is xAI's threat model, not shellX's. shellX does not
read or store xAI credentials itself.

### O4. Side-channels (timing, cache, power)
No defense against e.g. timing attacks on the auth flow beyond
constant-time string compare. Not a worthwhile defense surface
against an attacker who is already on the local box.

### O5. Supply-chain compromise
A malicious update to grok-build, Tauri, axum, reqwest, or any
dependency could leak everything. shellX runs `cargo audit` in its
GitHub Actions CI pipeline (`.github/workflows/ci.yml`) on every
push, but does not vendor dependencies. The user trusts the same
supply chain as any other Rust + Node app on their machine.

### O6. Physical access to an unlocked machine
Same as O1 — out of scope.

## Cross-reference

| Surface | Threat IDs | Defense location |
|---|---|---|
| shellXagent loopback port | T6 | `debug_api.rs::auth_middleware` |
| Host MCP HTTP loopback port | T6, T7 | `mcp_http.rs::auth + origin gate`, `mcp_http.rs::plan_mode_gate` |
| Host MCP stdio surface | T1, T2, T3, T5 | `host_mcp.rs::validate_fs_path`, redaction, `net_fetch` allow-list |
| ACP wire to grok | T2, T4 | `acp.rs::handle_terminal_create` intercept, `sessions/<sid>.jsonl` logging |
| Vault | T3 | `vault.rs` chacha20poly1305 + keyring-rs |
| SSH/WSL tunnel | T7 | (planned) `#330` per-session token |

## Known open exposures (acknowledged, tracked)

- **T7 / #330** — Static mcp.token on the remote-machine end of the
  SSH reverse tunnel. The tunnel uses the bound MCP port published in
  `~/.shellx/mcp-http.port`, not a fixed port. Tracked, hardening
  planned. Operator workaround: use trusted remotes only.
- **Autonomy 4-state collapse** — UI offers `Confirm / Auto /
  Observe / Propose`. At the wire, only Auto sends
  `--always-approve` + `--allow ...`. `Observe` and `Propose`
  behave identically to `Confirm`. Lie-shape; UI honesty fix tracked.
- **Token-file readability** — `shellxagent.token` and `mcp.token` are
  mode 0600 but any same-user process can read them. Equivalent
  exposure to `~/.aws/credentials`. Acceptable for single-user dev
  tool posture.

## Review cadence

Review this document on every release that touches an auth path,
adds a new MCP tool, adds a new wire surface, or changes a trust
boundary. Last review: 2026-05-20 (post trust-surface audit). Next:
alongside #330 implementation.
