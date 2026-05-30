---
name: shellx-host
description: >
  shellX host manifest. Read this at session start when running inside shellX.
  Defines host surfaces beyond a plain grok CLI: optional PTY terminals, vault, host
  MCP tools, debug API, per-tab sessions, `/build` orchestration, and the UI
  surfaces that render plan files, media, diffs, and live terminals.
metadata:
  short-description: "shellX host capabilities — vault, MCP, debug API, /build, optional PTY"
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

Access via the host MCP server. In many shellX sessions the same host
tools are advertised with both `grok-shell-host__` and
`shellx-host-http__` qualified names. Prefer `shellx-host-http__...`
for mutating or tab-aware tools when it is advertised because that
transport carries the active tab and permission gate. Use
`grok-shell-host__...` for read-only discovery or as the local fallback.

If `shellx-host-http__capabilities_summary` or
`grok-shell-host__capabilities_summary` is advertised, call it directly
for a compact current tool map before broad tool discovery. Use targeted
`search_tool` queries only for exact schemas; avoid `full_inventory`
unless debugging tool-schema drift, because the result is large and Grok
may store it as a session artifact instead of showing it clearly in chat.

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

For ordinary project files, prefer native Grok file tools:
`write`, `read_file`, `list_dir`, `grep`, and `search_replace`. On Local
Windows those native tools and host-MCP `fs_*` reach the same project
filesystem, so host `fs_*` is mainly for cases where shellX adds value:
atomic large or hot writes, binary/base64 reads or writes, Windows
parent-host paths from WSL/SSH sessions, explicit host permission/audit,
`fs_watch`, and copy/delete helpers. For WSL/SSH `/home/...` paths, use
native Grok file tools; host `fs_*` rejects POSIX paths by design.

Direct status/evidence tool map:
- `shellx_health` — debug API liveness.
- `session_tooling` — Tools/Grok-environment health rows for the tab.
- `grok_environment` — Grok version, MCP health, skills, trust, trace.
- `event_log` — recent shellX event frames for audit evidence.
- `process_list` / `process_stats` — host-tracked task state.
- `build_state` / `build_receipts` — `/build` status and gate evidence.
- `preview_state` / `preview_logs` / `preview_diagnose` — Work Preview
  status, server logs, browser/runtime diagnosis, and screenshot path.

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
- `GET /preview/work/state`, `POST /preview/work/start`,
  `POST /preview/work/stop`, `POST /preview/work/restart`,
  `GET|POST /preview/work/diagnose`.
- `GET|POST /connections`, `DELETE /connections/:id`,
  `POST /connections/:id/test`.
- `GET /vault/status`, `GET /vault/keys`, `POST /vault/get`,
  `POST /vault/set`, `POST /vault/delete`.
- `POST /tools/fs_watch`, `POST /tools/process_list`,
  `POST /tools/process_signal`, `POST /tools/process_stats`,
  `POST /tools/process_attach_stdout`, `POST /tools/secret_get`.

The user may drive YOU through this API from outside (curl, scripts,
other agents). Do not assume the preferred port is the bound port.

## 5.1. Work Preview and Environment Board

shellX stays passive until the user or you ask it to act. Use the
right-rail Tools board and Work Preview as your source of truth before
guessing how to run a generated app.

- Tools -> Grok environment includes MCP health, Grok inspect data,
  trace availability, and passive Preview setup checks for the active
  cwd.
- Static `.html` files can open in Work Preview directly. Scripts run
  in the sandboxed preview; no Node dependency install is required.
- Node web apps need project dependencies installed first. Respect the
  package manager lockfile: `pnpm-lock.yaml` -> `pnpm install`,
  `yarn.lock` -> `yarn install`, `bun.lock` / `bun.lockb` ->
  `bun install`, otherwise `npm install`.
- Expo web apps need `react-dom` and `react-native-web` present in
  `package.json`. When missing, use
  `npx expo install react-dom react-native-web` so versions match the
  installed Expo SDK.
- Work Preview binds generated app servers to loopback and owns the
  port. Use a separate public server only when the user explicitly asks
  for one.
- Start or restart Work Preview with `shellx-host-http__preview_start`
  when that prefix is advertised, otherwise `grok-shell-host__preview_start`.
  Do not ask an Agent shell subtask to run `npm run dev`, `npx expo
  start`, Vite, or Next just to satisfy the Work Preview gate; that
  bypasses shellX-owned preview state and Preview Doctor will still
  see `idle`.
- If a preview is blank, errors, or exits early, call
  `shellx-host-http__preview_diagnose` when available, otherwise
  `grok-shell-host__preview_diagnose`; read the HTTP result, process
  status, and log tail, then inspect the host-captured returned
  `screenshotPath` with `shellx-host-http__vision_describe` when
  available, otherwise `grok-shell-host__vision_describe`. Do not
  provide your own screenshot path for this gate. Fix the app before
  reporting success.

When presenting generated files in chat, use normal Markdown file links
inside the active cwd. shellX routes previewable HTML/app targets through
Work Preview and other document types through the file preview.

## 5.1.1. Attachments and session media

User attachments arrive as normal prompt context plus `[attached: <path>]`
markers. Text attachments may also arrive as embedded context. Treat both as
user-provided files and inspect them before making claims.

- The composer shows attachment chips for file picker, paste, drag/drop,
  screenshots, and Send to shellX; do not ask the user to retype paths that are
  already attached.
- On Windows, Send files to shellX is an opt-in Settings -> Desktop integration.
  Files delivered that way are still normal user attachments; inspect them
  through their provided paths.
- The bottom **Assets** button opens the Attachment & Media Board with pending
  attachments plus generated images/videos from the current session.
- For attached image files, do not call `read_file`; it reads UTF-8 text and
  will fail on PNG/JPEG bytes. Use `shellx-host-http__vision_describe` when
  available, otherwise `grok-shell-host__vision_describe`.
- If asked to compare or find content in attached files, use the paths and
  embedded context already provided instead of asking the user to upload again.
- Generated media paths under `~/.grok/sessions/.../images` and
  `~/.grok/sessions/.../videos` render in chat and in the Assets board.

## 5.2. Outside connectors

Outside connectors are configured by the user in Settings -> Connectors.
They are not general-purpose MCP tools; treat them as shellX-owned intake
and reply channels.

- Telegram is the first shipped live session-chat connector. In Inbox mode,
  allowlisted messages appear in shellX for user review. In Session chat mode,
  allowlisted direct messages are sent to the selected shellX tab and Grok's
  text reply is sent back to Telegram. If a reply references a local image
  path, shellX can send it as a Telegram photo.
- Discord is DM intake/inbox only in this release. Do not promise Discord
  session-chat replies until the app reports that mode as available.
- Do not ask users to paste bot tokens into chat. Tokens live in the shellX
  vault under connector-specific keys configured in Settings.
- When connector behavior is unclear, use the UI/debug API connector state
  and event log as source of truth. Do not invent delivery guarantees.

## 5.5. Long-horizon `/build` execution discipline

Build Mode wakes you back up after every turn until you call
`shellx-host-http__build_complete` when available, otherwise
`grok-shell-host__build_complete`. While in a `/build` run:

- Do NOT emit `stopReason="end_turn"` until verification gates have
  ALL replayed in chat with evidence. Phase completion is NOT build
  completion.
- After every tool call, ask: "Are gates PASSED with output pasted?"
  If not, continue. Don't summarize. Don't end the turn.
- Checklist boundaries are NOT natural stop points. When one section is
  done, continue immediately to the next unchecked section.
- Hard blocker (4 self-fix attempts failed): write the blocker, ask
  ONE focused question with options, end the turn cleanly. That is the
  only valid mid-build end-of-turn.
- When fully complete (every phase `Status: DONE`, every `- [ ]`
  rewritten to `- [x]`), you MUST call
  `build_complete` through the preferred shellX host prefix. Saying
  "all steps done" in chat is NOT a completion signal — shellX
  re-injects continuations until the tool fires.
- For UI/web/app work, call `preview_start`, then `preview_diagnose`;
  prefer the `shellx-host-http__` qualified name when advertised. Use
  the returned `screenshotPath` with `vision_describe` and fix every
  reported issue before calling `build_complete`.

The scratchboard path is the exact `build.<tab>.<run>.md` path shellX
provides in the `/build` kickoff prompt. Update that file in-place so
the user can watch progress in the Plan tab.

## 6. UI surfaces — where your output renders

You don't control the UI directly, but tool outputs land in specific
places:

- `/build` scratchboard at the provided `build.<tab>.<run>.md` path →
  approval modal and right-rail Plan tab. Keep top-level
  `Status: AWAITING_APPROVAL` until the user approves, then
  `IN_PROGRESS` until the `build_complete` tool succeeds.
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

## 7.5. Bundled grok skills that DON'T work as shellX gates in ACP mode

`implement`, `review`, `design`, `pr-babysit`, `best-of-n`,
`execute-plan`, and the verifier path inside `check-work` all depend on
upstream task/subagent plumbing. That plumbing is not a reliable shellX
Build Mode gate when grok is invoked over ACP stdio in shellX.

When the user asks for work those skills normally do, execute the
steps directly or use shellX's own `Agent` / `Agent_status` /
`Agent_output` MCP tools when they are available. Do not invoke the
bundled task-tool skills themselves for `/build` gates. Tell the user
once that those upstream task-tool skills are unavailable or degraded in
this ACP context and move on. Do not retry those bundled skills.

Grok 0.2.x may advertise `/check-work`; in shellX it can still be useful
as a manual self-check, but it is not proof that a reviewer/verifier
subagent ran. For `/build`, use shellX `Agent` receipts instead.

For `/build`, act as the manager for the approved Build Mode scratchboard:
use `Agent` with `subagent_type: implementer` for scoped code work,
`subagent_type: reviewer` for code review, and
`subagent_type: security-auditor` only for security-sensitive changes.
For changed behavior, use `subagent_type: test-writer` when coverage is
uncertain and `subagent_type: verifier` for evidence checks. For other
plan-alignment checks, use `subagent_type: general-purpose` with a focused
task and record the result in the provided Build Mode scratchboard.

## 8. When this applies

Read this once at session start. It overrides default assumptions
that you're in a plain terminal — you are inside a host application
that gives you more, and expects more.
