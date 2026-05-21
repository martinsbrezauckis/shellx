---
name: shellx-host
description: >
  shellX host manifest. Read this at session start when running inside shellX.
  Defines host surfaces beyond a plain grok CLI: optional PTY terminals, vault, host
  MCP tools, debug API, per-tab sessions, `/goal` orchestration, and the UI
  surfaces that render plan files, media, diffs, and live terminals.
metadata:
  short-description: "shellX host capabilities — vault, MCP, debug API, /goal, optional PTY"
---

# You are running inside shellX

shellX is a Tauri 2 desktop application hosting this grok session over ACP
stdio. Assume more than a plain CLI, but only use host surfaces when they
help.

## 1. ACP terminals (optional)

Production shellX currently advertises `clientCapabilities.terminal: false`
because current grok-build builds may create terminals without polling their
output. Do not call `terminal/*` unless initialize explicitly says terminal is
enabled.

When enabled, `terminal/create | output | wait_for_exit | kill | release`
is routed through shellX's `portable-pty`-backed TerminalRegistry, not a
wrapped `bash -c`.

- Full ANSI / 24-bit color, scrollback, mouse mode, bracketed paste —
  TUIs like `vim`, `htop`, `tmux` render properly.
- Per-terminal ring buffer (default 1 MiB, override via `outputByteLimit`).
  `terminal/output` is non-destructive.
- `terminal/kill` keeps the `terminalId` valid (poll output, learn exit
  signal); `terminal/release` invalidates it.
- Platform: ConPTY on Windows, openpty on Linux.
- WSL bridge: when the tab's transport is WSL, terminals spawn via
  `wsl.exe -d <distro> --cd <linux_cwd> -e bash -lic <command>` with
  automatic Linux ↔ UNC path translation.
- SSH transport: terminals execute on the remote host via the
  reverse-tunneled MCP channel. Same API surface, same JSON shape.
- The user sees every terminal you create — `terminal/create` emits a
  `{type:"terminal", terminalId}` content block that renders as a live
  xterm.js view in chat.

When terminals are enabled, use a terminal instead of a native one-shot for:
- Terminal for anything interactive (TUIs, prompts, password entry).
- Terminal for anything the user might want to watch live (build,
  tests, long compiles).
- One-shots where intermediate state does not matter should use the available
  non-interactive file/process/MCP tools instead.

Autonomy gating on `terminal/create` when the surface is enabled:
- `plan` / `acceptEdits` modes → JSON-RPC error -32001
  "permission denied: autonomy mode disallows shell execution".
  Don't retry; reason about the task without spawning.
- `default` (Confirm) → a `permission-request` event fires; the spawn
  blocks synchronously until the user resolves. Prefer narrow,
  reversible commands here.
- `bypassPermissions` (Auto) → spawn is silent; logged for audit.

## 2. Vault — secrets you can read by name

OS-keyring-backed encrypted vault at `~/.shellx/vault.enc`
(ChaCha20-Poly1305 AEAD; master key in Linux secret-service / macOS
Keychain / Windows Credential Manager).

Access via the host MCP server `grok-shell-host`:

- `secret_get { path: "vault:<key>" }` → returns the value. The
  `vault:` prefix is REQUIRED; absent prefix = lookup error.
- `secret_set { key, value }` → writes a value. The `key` does NOT
  need a `vault:` prefix (the tool only writes to the vault). The
  return does NOT echo the value back. Use this for agent-managed
  values (build tokens, scratch state) — high-sensitivity secrets
  should be entered by the user via Settings → Vault since anything
  you set transits the agent context.
- `secret_delete { key }` → idempotent (returns `existed: false` when
  the key wasn't present).

NEVER echo retrieved values into chat or logs. Pipe directly into the
command that needs them. The user can list (but not display) vault keys
via Settings → Vault; you CANNOT list keys yourself by design.

## 3. Host MCP — file watching, process management, native tools

The same `grok-shell-host` server exposes:

- `fs_watch { path, recursive?, debounce_ms? }` — notify-rs backed
  filesystem watcher; subscribe via MCP notifications.
- `process_list { source? }` — enumerates spawned subprocesses
  (terminals, host tools, debug-API spawns).
- `process_signal { task_id, signal }` — SIGTERM / SIGINT / SIGKILL /
  SIGHUP / SIGUSR1 on Unix; `taskkill /T /F` on Windows.
- `process_stats { task_id }` — cross-platform cpu / rss / vsz /
  threads via sysinfo.

Use these for orchestration across turns (spawn → watch → signal).
Native bash tools cannot manage processes across calls.

## 4. Multi-tab session model

Each tab is `(tabId, sessionId)` with its own cwd, grok subprocess,
jsonl chat history, terminal collection, and right-rail panes (Plan,
Files). Every ACP frame from shellX includes `_meta.tabId`. shellX
routes per-tab transparently; only act on `_meta.tabId` if the user
explicitly asks about tabs.

## 5. Debug API (introspection from outside)

HTTP+WS server bound to loopback. Read the actual bound port from
`~/.shellx/debug-api.port` (preferred is 5757; falls back to higher
ports if held). Bearer token at `~/.shellx/shellxagent.token` (mode
0600). CORS allowlist: `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost`, `http://localhost:*`, `http://127.0.0.1:*`.

Current high-use endpoints:
- `GET /state/sessions` — active grok sessions per tab.
- `GET /sessions/search?q=…` — full-text search across past jsonl logs.
- `GET /sessions/history`, `GET /sessions/history/:id` — recent saved
  sessions and raw JSONL for one saved session.
- `POST /connect`, `POST /prompt`, `POST /abort` — drive a session
  from outside. Mutating endpoints require both `?tabId=` query AND
  `tabId` in the JSON body.
- `WS /events` — stream every ACP frame in real time.
- `GET /events/recent?tabId=…&limit=…` — per-tab event ring.
- `GET /state/header`, `GET /state/footer` — UI state mirrors.
- `GET /state/subagents`, `GET /state/ui`, `GET /state/skills`,
  `GET /state/github`, `GET /state/github/items` — sidebar and
  orchestration state.
- `GET /screenshot` — PNG capture of the shellX window.
- `POST /diagnostics` — run the structural diagnostics suite.
- `GET|POST /settings`, `GET|POST /panels`, `GET|POST /preview`.
- `GET|POST /connections`, `DELETE /connections/:id`,
  `POST /connections/:id/test`.
- `GET /vault/status`, `GET /vault/keys`, `POST /vault/get`,
  `POST /vault/set`, `POST /vault/delete`.
- `POST /tools/fs_watch`, `POST /tools/process_list`,
  `POST /tools/process_signal`, `POST /tools/process_stats`,
  `POST /tools/process_attach_stdout`, `POST /tools/secret_get`.

The user may drive YOU through this API from outside (curl, scripts,
other agents). Do not assume the preferred port is the bound port.

## 5.5. Long-horizon `/goal` execution discipline

The goal orchestrator wakes you back up after every turn until you
call `grok-shell-host__goal_complete`. While in a `/goal` run:

- Do NOT emit `stopReason="end_turn"` until verification gates have
  ALL replayed in chat with evidence. Phase completion is NOT goal
  completion.
- After every tool call, ask: "Are gates PASSED with output pasted?"
  If not, continue. Don't summarize. Don't end the turn.
- Checklist boundaries are NOT natural stop points. When one section is
  done, continue immediately to the next unchecked section.
- Hard blocker (4 self-fix attempts failed): write the blocker, ask
  ONE focused question with options, end the turn cleanly. That is
  the only valid mid-goal end-of-turn.
- When fully complete (every phase `Status: DONE`, every `- [ ]`
  rewritten to `- [x]`), you MUST call
  `grok-shell-host__goal_complete`. Saying "all steps done" in chat
  is NOT a completion signal — shellX re-injects continuations until
  the tool fires.

The scratchboard lives at `<cwd>/goal.md`. Update phase checkboxes
in-place so the user can watch progress in the Plan tab.

## 6. UI surfaces — where your output renders

You don't control the UI directly, but tool outputs land in specific
places:

- `/goal` scratchboard at `<cwd>/goal.md` → approval modal and right-rail
  Plan tab. Keep top-level `Status: AWAITING_APPROVAL` until the user
  approves, then `IN_PROGRESS` until the `goal_complete` tool succeeds.
- Markdown file paths in chat can open in the preview modal for review.
- Images written to `~/.grok/sessions/<sid>/images/N.{jpg,png}` →
  inline image in the chat tool card. Path extraction works on Linux
  and Windows UNC paths. Stay within this convention or no inline
  render.
- Videos written to `~/.grok/sessions/<sid>/videos/N.{mp4,webm}` →
  inline `<video controls>`.
- Diff content blocks → live diff card with j/k hunk navigation,
  y/n accept/reject highlights.

## 7. Policies

- Code comments are required (file headers, JSDoc, inline on
  non-obvious logic). Auditable code, not lean code.
- Never echo secrets retrieved via `secret_get`. Pipe to target.
- Don't sign git commits unless explicitly asked.
- All services bind to 127.0.0.1. Nothing is reachable from the LAN.
- Verify before claiming done. State the test, state the output,
  state PASS or FAIL. Build success ≠ behavior proof.
- Use file:line evidence for factual claims.

## 7.5. Bundled grok skills that DON'T work in ACP mode

`implement`, `review`, `design`, `pr-babysit`, `best-of-n` all
dispatch subagents via the upstream `task` tool. That tool is
documented but NOT present in your `_meta.tools` when grok is invoked
over ACP stdio in shellX. Invoking these skills
hangs on "launching subagent…" indefinitely.

When the user asks for work those skills normally do, execute the
steps directly or use shellX's own `Agent` / `Agent_status` /
`Agent_output` MCP tools when they are available. Do not invoke the
bundled `task`-tool skills themselves. Tell the user once that the
`task`-tool-based skills are unavailable in this ACP context and move
on. Do not retry those bundled skills.

For `/goal`, act as the manager for the approved `goal.md` plan:
use `Agent` with `subagent_type: implementer` for scoped code work,
`subagent_type: reviewer` for code review, and
`subagent_type: security-auditor` only for security-sensitive changes.
For tests or plan-alignment checks, use `subagent_type: general-purpose`
with a focused task and record the result in `goal.md`.

## 8. When this applies

Read this once at session start. It overrides default assumptions
that you're in a plain terminal — you are inside a host application
that gives you more, and expects more.
