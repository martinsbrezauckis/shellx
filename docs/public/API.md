# ShellX local API reference

ShellX exposes an authenticated Debug API and Host MCP service on the local
desktop host. This is a reference for routes registered in the shipped app,
not a roadmap or an operational runbook.

The Debug API binds to `127.0.0.1` on a port chosen at startup. Its preferred
port is `5757` (`SHELLX_DEBUG_PORT` overrides it; the legacy
`GROK_SHELL_DEBUG_PORT` is still accepted) and it falls back through
`5759`/`5761`/`5763`/`5765`. Clients must use the atomically written
`~/.shellx/debug-api.port` discovery value rather than hard-coding a port. The
separate Host MCP HTTP port is published at `~/.shellx/mcp-http.port`.

## Current Implementation Inventory

Vault setup compatibility: `POST /vault/setup/begin` returns a `recoveryKit`
object with `confirmationId`, `words`, and `warning`. The `words` array is
empty because ShellX has no recovery-word or restore flow. The ID is a pending
setup confirmation challenge, not a backup key. `POST
/vault/setup/confirm-recovery` retains its existing route and ID field for
older clients; confirmation means the user accepted the stated loss risk, not
that recoverable material was created. Unlock still requires the master
passphrase and an available encrypted keyfile/profile and Vault data. Losing
required material can permanently lose access; ShellX does not export a
recovery file.

The router below is the current public runtime route inventory refreshed 2026-09-09.
Except for `GET
/health`, all Debug API routes require the per-user bearer and a local origin.

| Method | Registered paths |
| --- | --- |
| GET | `/health`, `/shellxagent.json`, `/.well-known/shellxagent.json`, `/agent-doc`, `/agent-doc/manifest`, `/agent-doc/skills/shellx-host/SKILL.md`, `/agent-doc/shellx-host/SKILL.md`, `/events/recent`, `/events`, `/state/header`, `/state/footer`, `/state/subagents`, `/state/ui`, `/state/files`, `/state/skills`, `/state/github`, `/state/github/items`, `/state/sessions`, `/state/background-tasks`, `/state/tabs/report`, `/state/agent_runs`, `/state/session_assets`, `/state/marketplace_health`, `/state/session_tooling`, `/state/environment`, `/state/grok_environment`, `/state/session_activity`, `/state/session_git`, `/state/session_git/diff`, `/state/model_instruction_cards`, `/state/agent_cli_setup`, `/panels`, `/preview`, `/preview/work/state`, `/preview/work/logs`, `/preview/work/diagnose`, `/screenshot`, `/settings`, `/sessions/history`, `/sessions/search`, `/sessions/history/:id`, `/sessions/:id/snippet`, `/goal/state`, `/build/state`, `/build/receipts`, `/provider-adapters/state`, `/provider-sessions/state`, `/vault/status`, `/vault/grants`, `/vault/agent-requests`, `/vault/keys`, `/vault/resources`, `/connections`, `/tasks`, `/tasks/states`, `/tasks/:task_id`, `/tasks/:task_id/state`, `/tasks/:task_id/attention`, `/tasks/:task_id/receipts`, `/outside-connectors`, `/outside-connectors/capabilities`, `/outside-connectors/events`, `/browser/check`, `/browser/summary`, `/browser/state`, `/browser/settle`, `/browser/tabs`, `/browser/profiles`, `/browser/tasks`, `/browser/history`, `/browser/requests`, `/browser/bookmarks`, `/browser/receipts`, `/browser/evidence`, `/browser/privacy`, `/browser/personal-lock`, `/browser/engine-pool`, `/browser/shields`, `/browser/developer-mode`, `/browser/teach/drafts`, `/browser/downloads`, `/browser/uploads`, `/browser/logs`, `/browser/storage-state`, `/browser/dialogs`, `/browser/permissions`, `/browser/popups`, `/browser/network`, `/browser/robots` |
| POST | `/connect`, `/prompt`, `/abort`, `/disconnect`, `/autonomy`, `/state/ui`, `/panels`, `/preview`, `/preview/work/start`, `/preview/work/stop`, `/preview/work/restart`, `/preview/work/diagnose`, `/state/environment/trace_export`, `/state/grok_environment/trace_export`, `/state/session_git/checkpoint`, `/state/session_git/worktree`, `/tools/fs_watch`, `/tools/process_list`, `/tools/process_signal`, `/tools/process_stats`, `/tools/process_attach_stdout`, `/tools/secret_get`, `/settings`, `/sessions/:id/archive`, `/tabs/:id/archive`, `/plan`, `/goal/start`, `/goal/stop`, `/goal/complete`, `/goal/pause`, `/goal/resume`, `/goal/approve`, `/goal/reject`, `/build/start`, `/build/stop`, `/build/complete`, `/build/receipt`, `/build/pause`, `/build/resume`, `/build/recheck_blocker`, `/build/operator_note`, `/build/approve`, `/build/reject`, `/permissions/:reqId/respond`, `/provider-adapters/run`, `/provider-sessions/start`, `/provider-sessions/abort`, `/agent_cli_setup/install/prepare`, `/agent_cli_setup/install/confirm`, `/agent_cli_setup/install/cancel`, `/agent_cli_setup/recheck`, `/diagnostics`, `/github/pr/create`, `/vault/lock`, `/vault/setup/begin`, `/vault/setup/confirm-recovery`, `/vault/remember-device`, `/vault/grants`, `/vault/grants/:grant_id/revoke`, `/vault/agent-requests`, `/vault/agent-requests/:request_id/cancel`, `/vault/get`, `/vault/set`, `/vault/delete`, `/vault/open-panel`, `/connections`, `/connections/provider-scan`, `/connections/:id/test`, `/tasks`, `/tasks/agent`, `/tasks/provider-catalog`, `/tasks/:task_id/revise`, `/tasks/:task_id/pause`, `/tasks/:task_id/resume`, `/tasks/:task_id/run`, `/tasks/runs/:occurrence_id/cancel`, `/tasks/:task_id/attention/:attention_id/resolve`, `/tasks/:task_id/attention/overflow/resolve`, `/outside-connectors`, `/outside-connectors/:id/test`, `/outside-connectors/:id/simulate`, `/browser/open`, `/browser/tabs/open`, `/browser/tabs/focus`, `/browser/tabs/reorder`, `/browser/tabs/close`, `/browser/tabs/lock`, `/browser/tabs/heartbeat`, `/browser/tabs/unlock`, `/browser/task/start`, `/browser/task/autonomy`, `/browser/task/control`, `/browser/task/finish`, `/browser/action`, `/browser/bookmarks`, `/browser/bookmarks/reorder`, `/browser/rendered-check`, `/browser/logs`, `/browser/privacy`, `/browser/personal-lock`, `/browser/engine-pool`, `/browser/shields`, `/browser/shields/site`, `/browser/developer-mode`, `/browser/developer-mode/approval`, `/browser/developer/inspect`, `/browser/teach/prepare`, `/browser/teach/revise`, `/browser/downloads/request`, `/browser/downloads/complete`, `/browser/uploads/request`, `/browser/uploads/complete`, `/browser/cdp/execute`, `/browser/trace/export`, `/browser/flight-recorder/export`, `/browser/evaluations`, `/browser/har/export`, `/browser/performance/export`, `/browser/recipes/export`, `/browser/recipes/replay`, `/browser/robots/schedule`, `/browser/robots/run`, `/browser/robots/cancel`, `/browser/storage-state/export`, `/browser/dialogs`, `/browser/dialogs/resolve`, `/browser/permissions`, `/browser/permissions/resolve`, `/browser/popups`, `/browser/session-grants/request`, `/browser/session-grants/resolve`, `/browser/session-grants/apply`, `/browser/vault-deposits`, `/browser/vault/fill-receipt`, `/browser/vault/generate-receipt`, `/browser/report` |
| DELETE | `/tools/fs_watch/:watchId`, `/connections/:id`, `/tasks/:task_id`, `/outside-connectors/:id`, `/browser/bookmarks/:bookmark_id`, `/browser/shields/site/:host` |

## Authentication, discovery, and events

UI highlights submitted through `POST /state/ui` report the portion of a
matched element inside the viewport and its clipping containers as
`visibleRect`. A highlight can also request `hitTest: { xFraction, yFraction }`,
with each fraction between 0 and 1. Its result reports `{ x, y, matches }` in
viewport coordinates; `matches` is true only when that point reaches the
element or its descendant. This observation neither scrolls nor activates the
control. Input clients should reject missing or negative hit-test results and
verify the resulting UI state after acting.

ShellX uses loopback binding plus a bearer token. Its process-owned token
authority is generated per user; ShellX-owned clients resolve it internally.
Custom integrations must obtain authority through a private process-local
integration, pass `Authorization: Bearer <token>`, and never print or persist
the token. The served `GET /shellxagent.json` and
`GET /.well-known/shellxagent.json` discovery records omit token values. The
bearer is trusted local operator authority, not an agent-isolation boundary;
agent-specific routes retain their own caller and intent checks.

`GET /health` is the unauthenticated liveness endpoint. It returns build,
Browser protocol, schema-revision, and feature-flag metadata. All other routes,
including the WebSocket event stream, are authenticated and reject non-loopback
origins. WebSocket clients that cannot set headers may use the local token query
parameter; do not place that URL in shell history, screenshots, or logs.

`GET /events/recent` returns a bounded in-memory event snapshot and `GET
/events` opens the live WebSocket. Event envelopes use Unix-millisecond `t`,
an event `kind`, optional `sessionId`, and JSON `payload`. Clients must treat a
missing `sessionId` as a global event. JSON request and response fields use
camelCase; timestamps are Unix milliseconds. New endpoint errors use a stable
machine-readable code plus a short message.

Desktop-bundled session documentation is available through `GET /agent-doc`,
`GET /agent-doc/manifest`, and `GET /agent-doc/skills/shellx-host/SKILL.md`.
The product-owned full reference is written to
`~/.shellx/agent-docs/shellx-host/SKILL.md`; it is not globally installed into
provider skill paths. ShellX-launched sessions receive compact runtime rules
and, when enabled, session-scoped ShellX host-MCP exposure. The result is that
direct CLI sessions stay unchanged: ShellX does not install a global skill, MCP
server, or runtime instruction block for them.

The private on-disk discovery descriptor is named `shellxagent.json` and is
written atomically for ShellX-owned local clients. Authenticated clients can
also fetch its non-secret form through `GET /shellxagent.json` or
`GET /.well-known/shellxagent.json`. The served form omits credential material
and advertises `rawCdpExposed: false`; Browser automation stays on the gated
`/browser/*` contract rather than a raw CDP endpoint.

Legacy `/goal/*` endpoints remain registered for compatibility. New
long-horizon work uses the receipt-backed `/build/*` routes.

## Host MCP gateway

ShellX exposes the compact `capabilities_summary`, `search_tool`, `host_read`,
`host_act`, `browser_read`, `browser_act`, `cut_read`, and `cut_act` gateway
tools. The 98 exact underlying Host schemas remain searchable through
`search_tool`; tool authority stays bound to the ShellX-launched process and
its active tab.

`host_read action:"fs_read"` returns a 16 KiB page by default with
`offset_bytes`, `bytes_returned`, `next_offset_bytes`, `truncated`, and
`approx_tokens`. An explicit page is capped at 1 MiB. This keeps a single call
from injecting an unbounded document into the provider context.

`cut_read action:"status"` returns a compact typed status only. Its **Check** control probes status only and never opens ShellX Cut; **Open** is an explicit operator action. With ShellX tooling enabled, Local agents use the parent desktop host. WSL uses
the ShellX host bridge and SSH uses its reverse tunnel.

For Browser work, the gateway replaces the legacy 32-tool, 82,893-byte
advertised schema with a two-tool, 2,601-byte `browser_read` / `browser_act`
entry surface. All 32 compatibility tools remain searchable and callable, but
their schemas are loaded only when needed. Normal observations have a
3,000-byte serialized budget and report their measured bytes and approximate
token count, keeping routine Browser turns bounded without removing site
control.

## Browser API

ShellX Browser is a task-owned, authenticated desktop browser surface. Use
`browser_read action:"tabs"`, `browser_act action:"navigate"`, then
`browser_read action:"observe"` to work from current refs. The compact Browser
gateway keeps the routine schema small; exact action schemas remain discoverable
through `search_tool`.

Use `browser_act action:"runSteps"` for a short generic batch when it reduces
round trips. Supported batch work includes safe in-page `findText` and
`extractTable`, plus ordinary `scroll`, `select`, `goBack`, `goForward`, and
`reload` actions. `findText` may use `query` as a convenience alias. Table
extraction is available through the `text/markdown/table` format family.
Navigation and history steps settle before the next dependent action. Every
step can include a compact `stepSummary`; structured recovery evidence stays
attached to the affected row, and a continued batch still reports an overall
failure when any step failed.

Observations traverse same-origin frames and open shadow roots. Cross-origin frames are counted but not traversed; cross-origin frames never yield actionable refs. Returned refs are scoped to their task,
tab, page revision, and observation generation; raw locators are never exposed.
Observations include bounded `addedRefIds` and `updatedRefIds` deltas. Actions
wait for attachment, visibility, stability, and hit-testability; a visible
moving target must settle for 120 ms before a click proceeds.

Browser task startup is transactional. `browser_task_engine_sync_failed`
returns rollback evidence after a partial task/webview is closed and the prior
active state is restored. Browser state and receipt endpoints expose redacted
summaries rather than page credentials or raw CDP.

Native Browser window startup is guarded by a bounded circuit breaker with
platform and environment classification, including Windows, macOS, Linux,
WSL, and WSLg diagnostics. A timed-out attempt reports
`browser_window_open_timeout`; another request arriving while that bounded
operation is still reconciling reports `browser_window_open_in_progress`.

Use `browser_rendered_check` for a bounded JavaScript-rendered liveness, text,
title, or selector check when no authenticated or interactive session is
needed. It opens an incognito hidden renderer, returns only redacted
match/count evidence, and leaves the visible Browser, task list, receipts, and
personal profile unchanged. Its restrictive page policy is defense in depth,
not a general network sandbox. Use the visible native ShellX Browser for
authenticated, interactive, approval-bearing, or human-cowork work.

Browser tab handoff asks the operator to review a `reviewFingerprint`; the
backend atomically revalidates the page, profile, ownership, and target task
before changing ownership. The operator/UI-only command is
`shellx_browser_delegate_tab_to_agent`.

The supported Browser routes cover navigation, tabs, task lifecycle, observed
actions, bookmarks, downloads/uploads, shields, dialogs, permissions, popups,
storage-state export, teach drafts, recipes, robots, evidence, flight recorder,
HAR/performance exports, and Vault-mediated fills. Use the route inventory for
the exact method/path and `GET /browser/summary` for installed capabilities.

### Bounded reads, settlement, and operator controls

- `GET /browser/summary` returns bounded Browser orientation under 16 KB:
  contract revisions, the active task/tab/engine, collection counts, and a
  small pending-request slice.
- `GET /browser/check` combines the bounded summary with a quiet settlement
  snapshot. It never creates a task, opens or focuses the Browser, mounts an
  engine, navigates, observes the DOM, or emits a receipt.
- `GET /browser/settle?taskId?&browserTabId?&timeoutMs?` is the compact
  navigation-settlement contract. With `timeoutMs`, the server waits internally
  and returns one bounded result instead of requiring repeated full-state
  polling.

Privacy and Shields settings are operator-owned UI controls. The corresponding
Debug API writes fail closed. ShellX invokes `shellx_browser_update_privacy`
for privacy/ad-mode changes, `shellx_browser_update_shields` for global Shields
defaults, and `shellx_browser_update_site_shields` for a per-site override.

`POST /browser/action` accepts current Browser actions including `navigate`,
`observe`, `extractText`, `extractMarkdown`, `extractTable`, `goBack`,
`goForward`, `reload`, `clickRef`, `fillRef`, `press`, `scroll`, `waitFor`,
`select`, `captureScreenshot`, `verify`, `findText`, `clearSiteData`,
`fillFromVaultGrant`, and `capturePageSecretToVault`. The native request filter
applies the selected strict Browser policy before page traffic is admitted.

On Linux, exact application-window capture requires an X11/Xwayland native
window handle. A native Wayland handle returns an explicit unavailable error;
setting `DISPLAY` alone does not select that capture backend, and an Xwayland
capture does not establish native-Wayland coverage.

### HTTP Debug API Browser flow for outside drivers

Agents running inside ShellX use Host MCP names. Outside drivers should prefer
the ShellX-owned Browser CLI, which discovers and authenticates to the private
loopback service without placing credential values in process arguments or
logs. A custom local client uses `Authorization: Bearer <token>` and maps the
compatibility tools to `POST /browser/action` as follows:

- `browser_navigate -> POST /browser/action` with `action: "navigate"`
- `browser_fill_from_vault -> POST /browser/action` with
  `action: "fillFromVaultGrant"`
- `browser_capture_secret_to_vault -> POST /browser/action` with
  `action: "capturePageSecretToVault"`
- `browser_screenshot -> POST /browser/action` with
  `action: "captureScreenshot"`

The installed CLI exposes the same bounded control surface. Use
`pnpm shellx-browser run-steps` for generic action batches. By default it starts
an isolated `agent-work` task; deliberate manual work can opt into the active
tab. `workflow-replay` returns a compact `summary` beside the raw replay result
so callers can inspect step counts, skipped reasons, and decision points first.
For visual-only controls and current-origin recovery, the direct fallbacks are
`pnpm shellx-browser click-at`, `pnpm shellx-browser type-text`, and
`pnpm shellx-browser clear-site-data`.

## Vault and mediated secrets

ShellX Vault is the default secret authority for ShellX sessions. `GET
/vault/keys` and `GET /vault/resources` return permitted metadata only. Grants
are scoped to the caller and intended operation; operators review execution
requests in the Vault Request Center.

| Method | Path | Current behavior |
| --- | --- | --- |
| POST | `/vault/lock` | Locks the local Vault session without revealing a value. |
| POST | `/vault/setup/begin` | Starts local or external setup and returns a confirmation ID; the legacy `recoveryKit.words` field is empty. |
| POST | `/vault/setup/confirm-recovery` | Confirms the pending setup ID and activates the selected Vault; this does not verify recovery material. |
| GET / POST | `/vault/grants` | Lists grant metadata or queues a scoped mediated-use grant. |
| GET / POST | `/vault/agent-requests` | Lists redacted executable-request state or queues an operator-reviewed request. |

### Raw secret reveal boundary

`POST /tools/secret_get` never returns plaintext. It returns
`RAW_SECRET_REVEAL_DENIED` for `vault:` values and
`LEGACY_PASS_REVEAL_DENIED` for legacy `pass:` references. Use mediated
fill/injection routes instead. Use mediated fill/injection only through a
reviewed Vault grant. `POST /vault/get` similarly denies raw reveal
with `raw_secret_reveal_denied`.


## Tasks, providers, connections, and sessions

### First-class Tasks and provider catalogue

`GET /tasks`, `GET /tasks/:task_id`, `GET /tasks/:task_id/state`, receipts,
and attention endpoints project stored task state. `POST /tasks` is the direct
trusted-operator draft route: an authenticated bearer holder may create the
supplied draft and it does not consume conversation Task intent. The
conversation-aware `POST /tasks/agent` route is available only to an
authenticated ShellX conversation and consumes one short-lived, tab-bound intent
registered from the current operator-authored composer message. The provider's
`userApproved` field is a compatibility assertion, not authority;
ordinary discussion cannot mint, retain, reuse, or escalate Task authority. A
create-only request cannot become create-and-run, and failed prompt delivery
clears the pending authority. A queued response proves durable acceptance
only. `POST /tasks/:task_id/run` starts one reviewed
occurrence and `POST /tasks/runs/:occurrence_id/cancel` cancels that exact
attempt.

For a terminal Task revision bound to a reviewed Browser workflow, ShellX can
attach a path-free result-evidence identity to the occurrence. It contains only
the bounded Flight Recorder attempt/report IDs, artifact digests,
completeness, and the source terminal-receipt identity; it does not expose the
private artifact path, page content, provider output, prompt, or credentials.

`POST /tasks/provider-catalog` reports safe provider availability and an
exactly one isolated ASCII semantic-version token when one is available. Its
`guidanceProvenance` records the bundled card revision separately from the
fresh target scan identified by `snapshotId`; neither the recorded card review
date nor a CLI version establishes a current native capability. That requires
a provider-specific native canary bound to the selected installed target. It
does not expose binary paths, binary hashes and sizes, raw probe diagnostics,
or credentials. The `task_manage` Host tool follows the same receipt-first and
current-composer-intent boundary. `tasks_persist_attachments`, `tasks_reclaim_attachments`, and
`tasks_maintain_attachments` are operator-only Tauri actions. There is no Debug API or Host MCP equivalent for durable Task attachment maintenance.

`POST /provider-sessions/start` launches a selected provider in the selected
ShellX context and streams normalized `provider-session-event` frames.
`GET /provider-sessions/state` exposes bounded run status and
`POST /provider-sessions/abort` ends the active run. ShellX does not silently route work to another provider: explicit handoff uses `send_prompt_to_provider`.
`GET /state/model_instruction_cards` returns bundled descriptive capability
cards and their recorded `lastReviewed` metadata for each selectable provider.
They explain intended native-media boundaries but do not establish current
installed-provider availability or native capability. Use `POST
/tasks/provider-catalog` or session preflight for availability on the selected
target, then record a provider-specific native canary for a current capability
claim.

For `providerId: "antigravity-cli"`, the current native Antigravity CLI has no video-generation tool. ShellX must
not launch Antigravity solely to attempt an unavailable video action; a media handoff never hands off to itself. Providers
run without ShellX tooling only when the selected session requests
off/no-ShellX-tooling mode.

Connections describe the local, WSL, SSH, and native Windows execution target.
Windows OpenSSH can run Windows agents directly; WSL is not required. Routes
such as `POST /connections/provider-scan` and `POST /connections/:id/test`
report a safe availability result for the target ShellX session.

## UI, preview, and operational state

`GET /state/ui` returns the debug-visible renderer snapshot and `POST
/state/ui` applies a bounded UI patch. Its documented fields include
`composerMenu?: "connection" | "agent" | "branch" | "close"`, `openModal?:`,
`cwdPicker?: true`, `activeTab: {`, and
`connectionId?: string; // explicit Local/WSL/SSH preset for listing`.
It also exposes `setupGuideDismissed?`, `contentClipped`, and `viewportWidth`
for renderer-safe inspection. Current UI patches can request
`debugClick?: string` and `debugInput?:` only for bounded desktop diagnostics.
`POST /autonomy` selects Full Auto for a chosen ShellX session; it is a visible
warning-level mode because permitted agent actions can proceed without a
per-action prompt.

UI snapshots describe reported state; they are not instructions to restore that
state. The main desktop and Browser renderers consume explicit operator patches from the
snapshot's `commandStream`, independently of `uiRevision`. Its backend-lifetime
`epoch` and command `sequence` prevent duplicate delivery across transports and
renderer reloads. Renderer reports do not enqueue commands. The in-memory stream
retains at most 64 commands and 128 KiB of patch data; an individual command over
64 KiB is rejected before its UI-state mutation. If commands expire before the
renderer reads them, it reports a failed `uiCommandDelivery` action and refuses
the remaining batch; reissue the intended commands. Stream acceptance is not
proof that a UI action completed: inspect its action results and rendered state.
Set `debugSurface` to `"app"` or `"browser"` to select the receiving renderer.
Without an explicit surface, source labels containing `browser` target Browser;
other operator commands target the main app.
Within `activeTab`, omitted fields keep the named tab's existing context. Set
`connectionId: null` explicitly to clear its saved connection; omitting
`connectionId` does not switch the tab away from that connection.

The bounded diagnostic UI patch also accepts a pointer-drag request. These
fields relay a transient renderer action and are not persisted as application
preferences:

```ts
type DebugUiPatch = {
  debugClick?: string | { selector: string; index?: number; text?: string };
  debugInput?: { selector: string; value: string; index?: number };
  debugDrag?: {
    selector: string;
    index?: number;
    text?: string;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    dx?: number;
    dy?: number;
    steps?: number;
  };
  debugSurface?: "app" | "browser";
};
```

`GET /state/background-tasks` returns a bounded live process projection with
`schema: "shellx/background-tasks@1"`, aggregate `count`, `truncated`, and
`tasks` rows containing only `taskId`, `origin`, `status`, `pid`, and `tabId`.
`truncated: true` means the result is incomplete; clients must reject it rather
than treating it as proof. Command, output, cwd, timing, and resource fields
are intentionally absent.

`GET /state/agent_runs` reports background provider activity. Provider-run metrics are derived from normalized event metadata. `GET /state/tabs/report`
provides the active-tab report for QA agents. `/state/environment`,
`/state/session_activity`, `/state/session_assets`, `/state/session_git`,
`/state/files`, `/state/skills`, and `/state/github` provide the corresponding
read-only projections.

`GET /state/session_activity` accepts `tabId`, `sessionId`, `sessionCwd`, and
`transport` query fields. Alongside the readable session source it returns a
compact derived report:

```ts
type ActivityReportItem = {
  path: string;
  relativePath: string;
  name: string;
  count: number;
  confidence: string;
  kinds: Record<string, number>;
  newestTimestampMs?: number;
  query?: string;
  command?: string;
  source: string;
};

type SessionActivityResponse = SessionActivitySource & {
  report: {
    schemaVersion: "shellx.sessionActivity.report.v1";
    summary: ActivityReportSummary;
    changes: ActivityReportItem[];
    readsAndSearches: ActivityReportItem[];
    git: ActivityReportItem[];
    commands: ActivityReportItem[];
  };
};
```

The Activity Browser's `[data-debug-id='activity-search']` control filters this
derived activity locally; it does not add an undocumented server-side search
parameter.

`GET|POST /preview` controls the right-hand preview target. `POST
/preview/work/start` starts a bounded local preview and the state/logs/diagnose
routes report its result. `/panels` and `/settings` persist user interface and
workspace preferences. `/outside-connectors` configures reviewed inbound
Telegram or Discord routing to the target ShellX session; the connector never
copies or relocates provider authentication state.

`POST /github/pr/create` requires `confirmRemoteCreate: true` and creates a
remote pull request only after that explicit request. ShellX does not make a
remote GitHub mutation from an ordinary provider action.
