---
name: shellx-host
description: >
  ShellX host-session manifest. Use only when the current prompt or runtime
  metadata positively identifies this session as running inside ShellX, when
  ShellX host tools are advertised, or when the user explicitly asks about
  ShellX host APIs or surfaces. Do not use merely because this skill is
  installed, a project mentions ShellX, or a task involves SSH, macOS,
  Windows, host transfers, file copies, images, or media.
metadata:
  short-description: "ShellX-only host capabilities — vault, Browser, MCP, debug API, /build"
---

# ShellX host session

## Activation precondition

Use this skill only after positive evidence that the current session is hosted
inside ShellX. Valid evidence is explicit ShellX ACP/session metadata in the
current prompt or runtime, advertised `shellx-host-http__*` or
`grok-shell-host__*` host tools, or an explicit user request about ShellX host
APIs or surfaces. Global skill availability, a ShellX repository or product
name, WSL/Windows context, SSH access, or an ordinary cross-host task is not
evidence. If this precondition is absent, stop using this skill and continue
with the normal agent tools.

shellX is a Tauri 2 desktop application hosting this grok session over ACP
stdio. Assume more than a plain CLI, but only use host surfaces when they
help.

## 1. ACP terminals are unavailable

Current ShellX builds always advertise `clientCapabilities.terminal: false` and
unconditionally rejects provider-originated `terminal/*` ACP requests with
JSON-RPC `-32601`. Do not retry those calls. Use the provider's native tools
or the ShellX `Agent` host tool for supervised work instead.

The interactive Terminal panel visible to the user is a separate,
operator-owned `portable-pty` surface. Its existence does not enable ACP
terminal access for an agent.

## 2. Vault — mediated secrets and grants

ShellX Vault is the ShellX secret authority. Agents plan from safe metadata,
then ask for mediated use. Do not ask for raw secret values and do not copy
secrets into chat. If Vault is manually locked, ask the user to unlock it in
the Vault panel before retrying grant-backed work.

Access via the host MCP server. In many shellX sessions the same host tools are
advertised with both `grok-shell-host__` and `shellx-host-http__` qualified
names. Prefer `shellx-host-http__...` for mutating or tab-aware tools when it
is advertised because that transport carries the active tab and permission
gate. Use `grok-shell-host__...` for read-only discovery or as the local
fallback.

If `shellx-host-http__capabilities_summary` or
`grok-shell-host__capabilities_summary` is advertised, call it directly
for a compact current tool map before broad tool discovery. Only eight compact
entry tools are advertised by default: `capabilities_summary`, `search_tool`,
`host_read`, `host_act`, `browser_read`, `browser_act`, `cut_read`, and
`cut_act`. Use targeted
`search_tool` queries for an exact hidden Host action schema, then pass the
action name and its exact fields through `host_read { action, params }` for
read-class operations or permission-gated `host_act { action, params }` for
mutations and external side effects. Prefer the `shellx-host-http__` qualified
gateway when advertised. The names in the Vault and Host maps below are action
names for that routing flow, not additional always-advertised tools. Avoid
`full_inventory` unless debugging tool-schema drift, because the result is
large and Grok may store it as a session artifact instead of showing it clearly
in chat. Browser actions use their dedicated `browser_read` and `browser_act`
gateways instead. ShellX Cut discovery and execution use `cut_read` and
`cut_act`; Cut's generated verb catalog stays behind that compact pair.

- `vault_list { prefix? }` → lists agent-visible Vault key/resource
  names, descriptions, and non-secret metadata for planning. It never
  returns values, and entries marked user-only are hidden.
- `vault_request_grant { secretRef, operation, actorScope? }` → creates
  a pending mediated-use grant request. It cannot approve itself and it
  cannot raw-reveal a secret. The request appears in the ShellX Vault
  Request Center for the operator.
- `vault_list_grants { secretRef?, status? }` → polls grant metadata and
  status. Use the grant only after `approved: true` and `revoked: false`.
- `secret_get { path: "vault:<key>" }` → raw Vault reveal is denied on
  the agent-facing MCP surface. Use grant-aware mediated Browser/Vault
  tools instead. `pass:<path>` and bare legacy pass-store references are
  also denied here so agents cannot bypass the Vault Request Center.
- `secret_set { key, value }` → legacy/write-only compatibility path. Prefer
  Browser/Vault deposit or user-entered Vault UI for durable credentials.
  Anything you pass to `secret_set` has already transited the agent context.
- `secret_delete { key }` → idempotent (returns `existed: false` when
  the key wasn't present).
- `vault_generate { origin, itemId, length?, includeUpper?, includeDigits?, includeSymbols? }`
  → permission-gated, create-only generation inside Vault. The password is
  stored without entering the agent result; an existing item is refused and
  never overwritten.

Never ask `secret_get` for plaintext. Plan from Vault names/descriptions
only, ask for a grant when needed, and let ShellX mediate fill/injection
so durable secrets do not enter the agent transcript.

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
When a parent-host text read is needed, discover `fs_read` and route it through
`host_read`. It returns a compact 16 KiB page by default with
`next_offset_bytes` and `approx_tokens`; continue from that exact offset only
when the task needs more of the document. Keep `max_bytes` small for planning
and never request a whole large document merely to find one section.

Searchable status/evidence action map:
- `shellx_health` — debug API liveness.
- `browser_check { taskId?, browserTabId?, timeoutMs? }` — bounded UI-silent
  Browser liveness/settlement check; it never creates a task, opens/focuses
  Browser, mounts an engine, navigates, observes DOM, or emits a receipt.
- `browser_rendered_check { url, expectText?, titleIncludes?, selector? }` —
  bounded incognito JavaScript-rendered check with redacted evidence and no
  visible Browser, task/tab, personal cookies, receipt, or persisted profile.
- `session_tooling` — Tools/Grok-environment health rows for the tab.
- `grok_environment` — Grok version, MCP health, skills, trust, trace.
- `event_log` — recent shellX event frames for audit evidence.
- `process_list` / `process_stats` — host-tracked task state.
- `build_state` / `build_receipts` — `/build` status and gate evidence.
- `preview_state` / `preview_logs` / `preview_diagnose` — Work Preview
  status, server logs, browser/runtime diagnosis, and screenshot path.

### ShellX Cut video editing from an agent

When ShellX Cut is installed and running, a confirmed ShellX-hosted agent can
inspect and edit the open video project through the same Cut MCP/verb engine as
the editor UI. ShellX does not register Cut's full generated catalog in every
prompt.

1. Call `cut_read { action: "status" }` to verify the installed Cut engine and
   its current environment.
2. Call `cut_read { action: "search", query }` to find a likely verb. Results
   are bounded and show argument names without injecting the full catalog.
3. Call `cut_read { action: "schema", verb }` for the exact input schema.
4. Call `cut_act { verb, arguments }` to execute it. Every exact Cut verb call
   is permission-gated because the current Cut MCP catalog does not publish a
   reliable read/mutation annotation to ShellX yet.

Use dotted Cut REST names or generated MCP names (`project.state` and
`project_state` resolve to the same MCP verb). Do not guess fields, call the
editor's private loopback API directly, or alter CLI/provider authentication.
Cut remains the project authority and returns its normal typed result,
operation receipt, or honest unavailable/error envelope.

### Native ShellX Browser for agent web work

ShellX includes a native, ShellX-owned Browser window and runtime. Use it for
web tasks instead of asking the user to paste credentials, cookies, page text,
or screenshots into chat.

For check-only work, use `browser_read action=check` for current Browser state,
`browser_read action=renderedCheck` for public/incognito JavaScript-rendered text, title, or
selector evidence, and `net_fetch` for plain HTTP. Use the visible Browser flow
below when work needs cookies, authentication, interaction, approvals, or human
cowork. The hidden rendered check is deliberately non-interactive and
non-sessioned; page-load JavaScript can still make ordinary web requests.

Host MCP Browser flow:

1. `browser_read action=tabs` or `browser_read action=state` — find the active Browser tab, profile,
   trust state, locks, and current URL. `browser_state` is a bounded summary by
   default and every visible Browser state/detail read is scoped to this
   authenticated caller session. Personal and other-agent Browser activity
   stays in the operator UI;
   saved workflow bookmarks remain discoverable as the deliberate Agent-facing
   catalog. Pass `include` only for the detail needed now; prior observations,
   receipts, network rows, history, and logs are opt-in slices.
2. `browser_act { action: "navigate", url, browserTabId? }` — open a URL in the native Browser.
   If you omit `browserTabId` and `taskId`, ShellX auto-starts or reuses an
   MCP-session-bound `task-disposable` Browser task. It does not use the user's
   personal tabs unless the user explicitly delegates one and you pass the task
   context. Pass an explicit `taskId` when deliberately joining a human-agent
   cowork task; another MCP session cannot implicitly reuse your bound task.
3. `browser_read { action: "observe", browserTabId? }` — get refs, locator suggestions,
   actionability metadata, stable fingerprints, grouped form intent
   (`formFieldGroups`), and safe page evidence. Unchanged controls keep the same
   deterministic ref across observations. Repeated observations include a
   bounded delta; when its compact summary reports `changed=false`, avoid
   re-planning the unchanged page. Otherwise use `refDelta` and `changeKinds`
   to focus the next step. MCP observe output has a 3,000-byte serialized
   structured-response budget by default and reports `mcpSerializedBytes` plus
   `mcpApproxTokens`; use
   `maxRefs`, `maxFormFields`,
   `maxAccessibilityNodes`, `includePageText`, or an explicit
   `maxPayloadBytes` when you need more. `fullObservation=true` is unbudgeted.
   Use
   `refId` for controls observed inside same-origin frames or open shadow roots;
   their displayed selector is local to that DOM scope. `domSummary` reports
   same-origin frame, cross-origin frame, open-shadow-root, and truncation
   counts. Cross-origin frames are never traversed. Use
   `browser_read action=extract`/`browser_act action=traceOpen` instead of dumping full observation
   JSON into files.
   API-key/token pages may expose redacted refs such as `secret-1` with action
   `capturePageSecretToVault`; pass those refs directly to
   `browser_act action=captureSecretToVault` with a durable `secretRef` instead of using
   clipboard reads, raw reveal, or hand-built selectors.
4. `browser_act action=clickRef` / `browser_act action=fillRef` /
   `browser_read action=waitFor` — act on refs returned by observe; click/fill
   may also use a precise selector when it comes from a fixture, saved workflow,
   or prior observation. Use tab lock fields when a tab is locked for an agent
   run. If a visible ref click reports applied but a Google-style menu/page
   state does not change, retry the same valid ref with `force=true` to dispatch
   native pointer input. Host MCP may recover stale click refs with a strict
   `stepSummary.locatorCandidates` selector, or retry automatically only when a
   normal click fails solely on `receivesEvents`; inspect `mcpRecovery` in the
   result when present.
   If an action returns `staleRef` or failed check `fingerprint`, ShellX did not
   act because the selector now identifies a changed element. Re-observe and use
   the replacement ref; do not force-click or locator-recover across that check.
   ShellX automatically gives DOM targets a short bounded wait to remain still
   across multiple geometry samples before clicking or filling. If `stable`
   still fails, treat the page as actively re-rendering and wait for its state
   transition instead of forcing the action; force never bypasses stability.
   For split buttons/dropdowns where the whole-button ref still does not change
   state, use `browser_act action=screenshot fullPage=true` and coordinate-click the visible
   arrow/subtarget.
   If a real rich
   editor, canvas surface, or visual-only app overlay has no usable ref, take a
   `browser_act action=screenshot` with `fullPage=true` and use the returned `pageSize` and
   `cssScale` to convert image pixels into viewport CSS coordinates before
   calling `browser_act action=clickAt` / `browser_act action=typeText`. Re-capture after Browser
   resize/minimize/restore; scroll off-screen full-page targets into the visible
   viewport before coordinate-clicking. Prefer refs for normal
   controls; never use coordinate typing to bypass Vault-mediated credential
   fills.
5. `browser_act action=runSteps` — run a short ordered batch of generic Browser action steps,
   such as `navigate -> waitFor -> observe -> clickRef -> scroll -> select -> findText -> extractTable -> verify`, when
   the task is already clear and batching will reduce MCP round trips. This is
   not a site-specific script runner: each step goes through the same Browser
   action gates as the single-action tools, and Vault fills, secret capture,
   wallet/email grants, approvals, dialog resolution, coordinate-only actions,
   uploads, and downloads stay as explicit separate tools. Navigate/history/
   reload steps wait for the task engine to settle before the next native Browser
   action runs. `findText`
   batch steps may use `query`; Host MCP maps it to the Browser action `value`
   field. `continueOnError` is flow control only: later steps may run, but any
   failure keeps aggregate `ok=false` / `isError=true`; inspect
   `stepsSucceeded`, `stepsFailed`, `continuedAfterFailure`, and
   `failureSummary`, while `stoppedAt` means execution ended early. If Host MCP
   recovers a click inside the batch, the step row includes structured
   `mcpRecovery` evidence.
6. If navigation returns `blockedBeforeUnload`, read the `dialogId` from the
   response message or receipt and use `browser_act action=resolveDialog` with the owning
   `taskId` to accept or dismiss only task-owned beforeunload prompts.
   Personal/delegated user-tab prompts still require ShellX operator UI.
7. If the page itself reports broken app resources and asks to clear
   application data, use `browser_act action=clearSiteData` on that current origin before
   retrying. It clears browser cache plus non-cookie app storage and preserves
   sign-in where the site allows it. If the page still asks to clear cookies,
   stop and request user approval; do not reset sign-in state silently.
8. `browser_read action=workflows` / `browser_act action=workflowSave` /
   `browser_act action=workflowReplay` —
   before repeating a known site workflow, search saved Agent workflow bookmarks
   by taxonomy such as `siteKey=google.com taskType=get target=api-key`,
   `surface=drive`, or `secretKind=apiToken`. Rehearse with dry-run first,
   inspect `stepResults`, `decisionPoints`, planned/skipped steps, and
   contract/health/drift metadata, and only use `apply=true` when the user/task
   contract allows replaying the saved route. Apply mode executes recorded
   navigation/click/wait/select/press/verify fast-track steps, then you must
   observe and continue live for redacted inputs, redacted text-only wait/search
   points, Vault fills/captures, or page drift. If a replay step reports
   `redactedTextRequiresFreshObservation`, observe the current page and continue
   with current selectors or mediated Vault/user bindings instead of asking for
   the raw text. After a successful repeated user-requested task, use
   `browser_act action=workflowSave` to export the recipe and store a reusable fast track.
   If no workflow matches, continue with live navigate and observe actions.
9. `browser_read action=extract` / `browser_act action=savePage` /
   `browser_read action=verify` / `browser_act action=screenshot` /
   `browser_read action=downloads` / `browser_act action=traceOpen` — collect
   evidence, extract page text/markdown/table data (`format: table` may include
   a selector), save page text/markdown to explicit `destinationDir`, the
   Browser default download folder, or OS Downloads with a returned `finalPath`,
   list completed transfer paths, capture full-page screenshots, and export
   redacted traces.

For repeatable Browser evidence, call
`browser_act action=flightRecorderExport` after each baseline/candidate attempt
and retain only its returned `attemptId`, private path, byte count, and SHA-256.
Use a fresh caller-owned Browser task for every baseline or candidate attempt;
one live task cannot populate multiple comparison cohorts. After collecting
the exact source-bound attempt identities, call
`browser_act action=evaluationWrite` with a fixed `evaluatedAtMs` and declared
outcome metrics. ShellX verifies every artifact under private Flight Recorder
storage, requires the artifact suite/group identity to match, writes a
deterministic bounded report, and returns an error result
when evidence is missing/incomplete or the candidate is unsafe. Use
`browser_read action=evidence` to list only the current ShellX session's recent
recorder/evaluation receipts. These artifacts are not a route for raw Browser
state or secret values into a project folder.

For one bounded native developer review, use `browser_read
action=developerInspect` with the caller-owned `taskId` and optional
`browserTabId`. It returns a compact sanitized summary of document checks,
console/network counts, performance, deterministic issues, and truncation. It
never accepts arbitrary JavaScript or CDP methods. If it reports
`developerModeRequired`, stop for the operator to approve that Browser host in
ShellX; do not try to route around the native Browser or use external Chrome.
HAR and performance export buttons are operator-only controls in Browser
Evidence and are not agent actions.

To turn one complete Flight Recorder attempt from a completed task into an
editable workflow draft, call `browser_act action=teachPrepare` with its exact
`attemptId`. Use
`browser_read action=teachDrafts` with the owning `taskId` and optional `limit`
to recover compact current draft identities. Preparing is deterministic and
does not call a model, approve a recipe, or run actions. Revision, Vault-binding
selection, recipe approval, and rehearsal remain in the Browser Evidence UI.
Approval creates an ordinary private Action Recipe V2 only; rehearsal uses the
existing dry-run planner and applies zero steps. Continue live for any redacted
input or Vault-mediated step that the recipe planner reports as requiring a
fresh binding.

Agents running from the ShellX source package can use its Browser CLI fallback.
Use `pnpm shellx-browser run-steps --steps-json ...` for short generic Browser
batches; it starts an `agent-work` task by default so it does not act on the
operator's active personal tab. Pass `--task`/`--tab` for an explicit target, or
`--use-active-tab` only for deliberate manual active-tab work. Direct fallbacks
for visual-only controls or current-origin app-cache recovery are:
`pnpm shellx-browser click-at 128 240 --task <taskId>`,
`pnpm shellx-browser type-text 128 240 "hello" --task <taskId>`, and
`pnpm shellx-browser clear-site-data --task <taskId>`. `pnpm shellx-browser
workflow-replay ...` returns a compact `summary` beside the raw `replay`;
inspect the summary counts, skipped reasons, and decision-point count before
continuing live.

Do not write raw Browser state or observation JSON dumps into
the current working directory, Downloads, or other user folders as task evidence.
Use `browser_act action=traceOpen` for bounded redacted diagnostics, and use
`browser_act action=savePage` only when the user explicitly wants page content saved.

Vault-backed Browser actions:

- `browser_act action=fillFromVault` fills a field from an approved Vault grant without
  returning the secret to the agent.
- `browser_act action=fillProfileCard` fills one approved profile-card field.
- `browser_act action=captureSecretToVault` stores a generated password, API key, or
  other page-visible secret directly into Vault and returns only a receipt. Use
  redacted `secret-*` refs from observe whenever they are available.
  If a service only shows masked keys, prefer its Copy control or a visible leaf
  value selector. Avoid re-observing revealed keys unless needed; ShellX redacts
  known credential patterns, but capture itself should be host-mediated and
  write-only.
- `browser_act action=readEmailCode` reads an approved short verification code from an
  email resource.
- `browser_act action=useAgentWallet` is reserved for ShellX agent wallets, not
  user payment cards. In the current release it returns
  `browser_agent_wallet_checkout_unavailable` until a real provider transaction
  bridge can prove the checkout; approval alone is not success.

Credential/session use, payments, final submit/publish, destructive actions,
and insecure-page credential entry are Browser/Vault approval-gated. Agents may
request those actions but must not bypass ShellX Browser or Vault policy.

When dispatching `Agent` subagents for web work, include this same Browser flow
in the task if the subagent may need page evidence or navigation. ShellX also
injects a runtime guard that tells subagents the native Browser exists.

### Media Handoff Recipes

When the user explicitly names a media provider, use the recipe that matches
the current provider context. A target provider uses its native media tool;
only a different ShellX-host-enabled provider/session uses a ShellX handoff.
Do not search docs, inspect provider logs, or run raw provider CLI commands
first.

GPT Image via Codex:
- Call `shellx-host-http__send_prompt_to_provider`.
- Use `providerId: "codex-cli"` and `userApproved: true`.
- Omit `targetTabId` for same-tab handoff unless the user names another tab.
- Ask Codex to use OpenAI image generation and return the generated image path.
- Do not run `codex exec` directly. Do not inspect `.codex` logs unless the
  user asks for debugging after a failed ShellX handoff.
- Do not set `timeoutMs` below `900000`; omit it when unsure.

Antigravity image generation:
- In an already-running Antigravity session, call native `generate_image`
  directly; do not hand off to Antigravity from Antigravity.
- From a different ShellX-host-enabled provider/session, use the explicit
  handoff below only after the user names or approves Antigravity.
- Call `shellx-host-http__send_prompt_to_provider`.
- Use `providerId: "antigravity-cli"` and `userApproved: true`.
- Omit `targetTabId` for same-tab handoff unless the user names another tab.
- Set `includeShellxTooling: false` to select the target provider session's
  existing off/no-ShellX-tooling mode unless the task independently needs
  ShellX tooling, and do not set `timeoutMs` below `900000`; omit it when unsure.
- Ask Antigravity to use native `generate_image`, choose an operator-visible
  `ImageName`, and return the generated artifact path or receipt. Pass
  `AspectRatio` or `ImagePaths` only when the user supplied them.
- Do not replace `generate_image` with Browser automation, Vision Describe,
  raw provider CLI commands, or another provider. Ask before any fallback.

Antigravity video generation (unavailable):
- The current native Antigravity CLI has no video-generation tool. Do not launch
  Antigravity solely for this unsupported request.
- Video attachment or analysis and ShellX Browser WebM recording do not count
  as Antigravity video generation.
- State the availability boundary and ask before routing to Grok Imagine or any
  future video provider.
- When the installed Antigravity version changes, refresh this rule from the
  official tool catalogue and one live no-tool ShellX canary.

Grok Imagine image:
- Call `shellx-host-http__send_prompt_to_session`.
- Use `userApproved: true`.
- Omit `targetTabId` for same-tab handoff unless the user names another Grok
  tab.
- Ask Grok to use Grok Imagine image/editing and return the generated image
  path.
- Do not switch to GPT Image or another provider unless the user approves that
  fallback.

Grok Imagine video:
- Call `shellx-host-http__send_prompt_to_session`.
- Use `userApproved: true`.
- Omit `targetTabId` for same-tab handoff unless the user names another Grok
  tab.
- Ask Grok to use Grok Imagine video or image-to-video and return the generated
  video path.
- Do not switch to another video provider unless the user approves that
  fallback.

## 4. Multi-tab session model

Each tab is `(tabId, sessionId)` with its own cwd, grok subprocess,
jsonl chat history, terminal collection, and right-rail panes (Plan,
Files). Every ACP frame from shellX includes `_meta.tabId`. shellX
routes per-tab transparently; only act on `_meta.tabId` if the user
explicitly asks about tabs.

## 5. Debug API (introspection from outside)

HTTP+WS server bound to loopback. Read the actual bound port from
`~/.shellx/debug-api.port` (preferred is 5757; falls back to higher
ports if held). ShellX-owned clients resolve the private per-user bearer
internally; custom clients must receive it through a private process-local
integration and must not read, print, or persist raw credential material.
CORS allows exactly `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost`, `http://localhost:5173`, and
`http://127.0.0.1:5173`; other localhost ports are not allowed.

Current high-use endpoints:
- `GET /shellxagent.json` — local discovery descriptor for the bound Debug API,
  gated Browser paths, and agent-doc links.
- `GET /agent-doc/manifest`, `GET /agent-doc/skills/shellx-host/SKILL.md` —
  the bundled host-skill docs that installed agents also receive on disk.
- `GET /state/sessions` — per-tab rows merging active Grok ACP and
  provider-session context.
- `GET /sessions/search?q=…` — full-text search across past jsonl logs.
- `GET /sessions/history`, `GET /sessions/history/:id` — recent saved
  sessions and raw JSONL for one saved session.
- `POST /connect`, `POST /prompt`, `POST /abort` — drive a session
  from outside. Mutating endpoints accept the tab selector in either the
  `?tabId=` query or the JSON body's `tabId`; when both are present, the query
  value takes precedence. One connect may start per tab; a parallel connect
  fails with `409 connect_in_progress`. Aborting a provider handshake returns
  `202 connectCancellationRequested` immediately, the original connect returns
  `409 connect_cancelled` after cleanup, and callers must wait for that cleanup
  before reconnecting.
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
- `GET /browser/check`, `GET /browser/summary`, `GET /browser/state`, `GET /browser/settle`,
  `GET /browser/tabs`, `GET /browser/history`, `GET /browser/requests`,
  `POST /browser/action`,
  `POST /browser/recipes/export`, `POST /browser/recipes/replay` — native
  Browser state, actions, and workflow recipe surfaces.
- `POST /tools/fs_watch`, `POST /tools/process_list`,
  `POST /tools/process_signal`, `POST /tools/process_stats`,
  `POST /tools/process_attach_stdout`, `POST /tools/secret_get`.

### HTTP Debug API Browser flow for outside drivers

The MCP tool names in the Browser section are for agents running inside
ShellX. Outside drivers should prefer the ShellX-owned Browser CLI, which
performs private loopback discovery and authentication without placing bearer
values in shell history, arguments, or logs. Custom clients still use the raw
`/browser/*` routes and `Authorization: Bearer <token>`, but must obtain that
credential through a private process-local integration.

Minimal outside-driver loop:

```bash
pnpm shellx-browser tabs
pnpm shellx-browser snapshot
pnpm shellx-browser run-steps --steps-json \
  '[{"action":"navigate","url":"https://example.com"},{"action":"observe"}]'
```

The routed `browser_read`/`browser_act` tools call the same operations below.
These legacy names document exact compatibility mappings and can be found with
targeted `search_tool` queries:

- `browser_navigate -> POST /browser/action` with `action: "navigate"` and `url`.
- `browser_observe -> POST /browser/action` with `action: "observe"`.
- `browser_click_ref -> POST /browser/action` with `action: "clickRef"`, `refId` or `selector`, and optional `force`.
- `browser_click_at -> POST /browser/action` with `action: "clickAt"`, `x`, and `y`.
- `browser_fill_ref -> POST /browser/action` with `action: "fillRef"`, `refId` or `selector`, and `value`.
- `browser_type_text -> POST /browser/action` with `action: "typeText"`, `x`, `y`, and `value`.
- `browser_clear_site_data -> POST /browser/action` with `action: "clearSiteData"`.
- `browser_wait_for -> POST /browser/action` with `action: "waitFor"`, `value` or `selector`, and optional `timeoutMs`.
- `browser_extract -> POST /browser/action` with `action: "extractText"`, `action: "extractMarkdown"`, or `action: "extractTable"`.
- `browser_verify -> POST /browser/action` with `action: "verify"`, `key`, and expected `value` or selector/table/schema metadata.
- `browser_screenshot -> POST /browser/action` with `action: "captureScreenshot"` and optional `fullPage: true`.
- `browser_fill_from_vault -> POST /browser/action` with `action: "fillFromVaultGrant"`, `grantId`, `secretRef`, and `refId` or `selector`.
- `browser_fill_profile_card -> POST /browser/action` with `action: "fillProfileCardGrant"`, `grantId`, `resourceRef`, `key`, and `refId` or `selector`.
- `browser_capture_secret_to_vault -> POST /browser/action` with `action: "capturePageSecretToVault"`, `secretRef`, and `refId` or `selector`. Directly visible field/text values are deposited without being returned; copy-only controls stop for an explicit operator clipboard transfer, and ShellX neither clicks them nor reads the host clipboard.
- `browser_read_email_code -> POST /browser/action` with `action: "readEmailCodeGrant"`, `grantId`, and `resourceRef`.
- `browser_use_agent_wallet -> POST /browser/action` with `action: "useAgentWalletGrant"`, `grantId`, and `resourceRef`; currently returns a truthful unavailable result until provider transaction proof is wired.
- `browser_downloads -> GET /browser/downloads`.
- `browser_resolve_dialog -> POST /browser/dialogs/resolve` with `dialogId`, `taskId`, and `action: "accept"` or `"dismiss"`.
- `browser_trace_open -> POST /browser/trace/export`.
- `browser_workflows -> GET /browser/bookmarks` and filter rows with `agentWorkflow`.
- `browser_workflow_save -> POST /browser/recipes/export`, then `POST /browser/bookmarks` with `agentWorkflow`.
- `browser_workflow_replay -> POST /browser/recipes/replay`.
- `browser_run_steps -> repeated POST /browser/action` calls using the same task/tab context, or the bundled `pnpm shellx-browser run-steps` helper when shell access is available.

Raw HTTP route inventory for ShellX Browser:

- Reads: `GET /browser/check`, `GET /browser/summary`, `GET /browser/state`, `GET /browser/settle`,
  `GET /browser/tabs`, `GET /browser/profiles`, `GET /browser/tasks`,
  `GET /browser/history`, `GET /browser/requests`, `GET /browser/bookmarks`,
  `GET /browser/receipts`,
  `GET /browser/privacy`, `GET /browser/personal-lock`,
  `GET /browser/engine-pool`, `GET /browser/shields`,
  `GET /browser/developer-mode`, `GET /browser/teach/drafts`, `GET /browser/downloads`,
  `GET /browser/uploads`, `GET /browser/logs`,
  `GET /browser/storage-state`, `GET /browser/dialogs`,
  `GET /browser/permissions`, `GET /browser/popups`,
  `GET /browser/network`, and `GET /browser/robots`.
- Tab/task/actions: `POST /browser/open`, `POST /browser/tabs/open`,
  `POST /browser/tabs/focus`, `POST /browser/tabs/reorder`,
  `POST /browser/tabs/close`, `POST /browser/tabs/lock`,
  `POST /browser/tabs/heartbeat`, `POST /browser/tabs/unlock`,
  `POST /browser/task/start`, `POST /browser/task/autonomy`,
  `POST /browser/task/control`, `POST /browser/task/finish`, and
  `POST /browser/action`. Task policy is fixed to `assistedAutonomous`;
  `/browser/task/autonomy` remains only as a stable
  `browser_task_autonomy_policy_fixed` denial path.
- Bookmarks/settings: `POST /browser/bookmarks`,
  `POST /browser/bookmarks/reorder`, `DELETE /browser/bookmarks/:bookmark_id`,
  `POST /browser/logs`, `POST /browser/engine-pool`,
  `POST /browser/privacy`, `POST /browser/personal-lock`,
  `POST /browser/shields`, `POST /browser/shields/site`,
  `DELETE /browser/shields/site/:host`, `POST /browser/developer-mode`,
  `POST /browser/developer-mode/approval`, `POST /browser/developer/inspect`,
  `POST /browser/teach/prepare`, and `POST /browser/teach/revise`. Privacy, Personal Lock, Shields,
  and Developer Mode writes are operator-only denial paths over Debug API.
- Artifacts/workflows: `POST /browser/downloads/request`,
  `POST /browser/downloads/complete`, `POST /browser/uploads/request`,
  `POST /browser/uploads/complete`, `POST /browser/cdp/execute`,
  `POST /browser/trace/export`, `POST /browser/har/export`,
  `POST /browser/performance/export`, `POST /browser/recipes/export`,
  `POST /browser/recipes/replay`, `POST /browser/robots/schedule`,
  `POST /browser/robots/run`, `POST /browser/robots/cancel`, and
  `POST /browser/storage-state/export`.
  Path-based recipe replay accepts only the exact artifact represented by its
  in-session `browserRecipeExported` receipt; changed, copied, or unreceipted
  recipe files fail closed. Inline recipes remain available for direct plans.
  Robot `run` executes the saved recipe planner or live replay before returning
  a terminal job. Treat `incomplete` or `failed` as failure requiring receipt
  inspection; `runAtMs` is queue metadata until a due-job runner invokes `run`.
- Prompts/session/Vault/report: `POST /browser/dialogs`,
  `POST /browser/dialogs/resolve`, `POST /browser/permissions`,
  `POST /browser/permissions/resolve`, `POST /browser/popups`,
  `POST /browser/session-grants/request`,
  `POST /browser/session-grants/resolve`,
  `POST /browser/session-grants/apply`, `POST /browser/vault-deposits`,
  `POST /browser/vault/fill-receipt`,
  `POST /browser/vault/generate-receipt` (a fail-closed compatibility denial),
  and `POST /browser/report`.

Raw HTTP callers still cannot self-approve operator-only actions. Vault grants,
session grants, permission prompts, unsafe downloads/uploads, Developer Mode,
privacy/Shields writes, and Personal Browser Lock changes remain mediated by
the ShellX UI/Tauri operator path.

The user may drive YOU through this API from outside (curl, scripts,
other agents). Do not assume the preferred port is the bound port.

## 5.1. Work Preview and Environment Board

shellX stays passive until the user or you ask it to act. Use the
right-rail Tools board and Work Preview as your source of truth before
guessing how to run a generated app.

- Tools -> Environment includes agent CLI health, MCP/tooling state,
  trace availability, and passive Preview setup checks for the active cwd.
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

- Telegram and Discord support Inbox and Session chat modes. In Inbox mode,
  allowlisted direct messages appear in shellX for user review. In Session chat
  mode, they are sent to the selected live Grok, Codex, Claude, or Antigravity
  tab, and the captured text reply is sent back through the originating bot.
  Telegram can also send a referenced local image path as a photo.
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
- Never use `secret_get` for plaintext. Request a Vault grant and use a
  mediated fill/injection path.
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

Apply this manifest only after the activation precondition is satisfied. In a
confirmed ShellX-hosted session, it overrides plain-terminal assumptions with
the host surfaces above. Outside ShellX, do not invoke it.
