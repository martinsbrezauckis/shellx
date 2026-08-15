# shellX — Agent-First Protocol (HTTP + WS Surface on `127.0.0.1:<bound-port>`)

> The shellXagent HTTP+WS server binds to `127.0.0.1` on a port chosen at
> startup. The preferred port is `5757` (overridable via
> `SHELLX_DEBUG_PORT`; legacy `GROK_SHELL_DEBUG_PORT` also works); when busy the server steps up to
> `5759`/`5761`/`5763`/`5765`. The **actually-bound** port is written
> atomically to `~/.shellx/debug-api.port` — external drivers must read
> that file rather than hard-coding `:5757`. The host MCP HTTP server
> publishes its port to `~/.shellx/mcp-http.port` the same way.

**Status:** Implementation guide plus v1.x roadmap (drafted 2026-05-17,
current route inventory refreshed 2026-08-14).
**Audience:** Any future implementer (human or agent) extending shellX's
debug API beyond what is already wired in `src-tauri/src/debug_api.rs` and the
`src-tauri/src/debug_api_browser*.rs` route handlers.
**Goal:** Expose authenticated orchestration and observable application state
without pretending that native keyboard, palette, drag/drop, or OS-picker
behavior is an HTTP surface. The final release harness combines this API with
installed-app WebDriver and native-input drivers.

The wired route table in `src-tauri/src/debug_api.rs` is the source of truth
for what clients can call today; Browser handler behavior is split through
`debug_api_browser*.rs` modules. Sections below that describe routes not listed
in the current implementation inventory are roadmap targets, not shipped
endpoints. Breaking changes to wired routes require bumping `X-API-Version`
major and shipping a migration shim.

## Current Implementation Inventory

These routes are wired today. All routes except `GET /health` require the
private per-user Debug API bearer. ShellX-owned clients resolve it internally;
custom clients must receive it through a private process-local integration and
must not read, print, or persist raw credential material. On launch ShellX also
writes a private discovery descriptor containing the bound Debug API URL,
credential material for ShellX-owned local clients, and gated Browser route
paths. The same non-secret discovery metadata is available to authenticated
local clients at `GET /shellxagent.json`. Installer-bundled agent docs are available at
`GET /agent-doc/manifest` and
`GET /agent-doc/skills/shellx-host/SKILL.md`. None of these surfaces
expose raw CDP.

`GET /screenshot` captures the ShellX window by default. If no matching
window can be found it returns an error; `?fullScreen=1` is an explicit,
authenticated opt-in to capturing the entire primary monitor. Treat that
option as privacy-sensitive because any holder of the bearer can request it.

`GET /health`, the discovery descriptor, and the host MCP `initialize`
response expose the app version, source commit, Browser protocol version,
Browser schema revision, and Browser feature flags. Automation clients should
check these fields before a run and fail or downgrade deliberately when their
expected Browser contract does not match the installed host.

| Method | Path |
| --- | --- |
| GET | `/health`, `/shellxagent.json`, `/.well-known/shellxagent.json`, `/agent-doc`, `/agent-doc/manifest`, `/agent-doc/skills/shellx-host/SKILL.md`, `/agent-doc/shellx-host/SKILL.md`, `/events/recent`, `/events`, `/state/header`, `/state/footer`, `/state/subagents`, `/state/ui`, `/state/files`, `/state/skills`, `/state/github`, `/state/github/items`, `/state/sessions`, `/state/tabs/report`, `/state/agent_runs`, `/state/session_assets`, `/state/marketplace_health`, `/state/session_tooling`, `/state/environment`, `/state/grok_environment`, `/state/session_activity`, `/state/session_git`, `/state/session_git/diff`, `/state/model_instruction_cards`, `/state/agent_cli_setup`, `/panels`, `/preview`, `/preview/work/state`, `/preview/work/logs`, `/preview/work/diagnose`, `/screenshot`, `/settings`, `/sessions/history`, `/sessions/search`, `/sessions/history/:id`, `/sessions/:id/snippet`, `/goal/state`, `/build/state`, `/build/receipts`, `/provider-adapters/state`, `/provider-sessions/state`, `/vault/status`, `/vault/grants`, `/vault/agent-requests`, `/vault/keys`, `/vault/resources`, `/vault/e2e/audit`, `/connections`, `/tasks`, `/tasks/states`, `/tasks/:task_id`, `/tasks/:task_id/state`, `/tasks/:task_id/attention`, `/tasks/:task_id/receipts`, `/outside-connectors`, `/outside-connectors/capabilities`, `/outside-connectors/events`, `/browser/check`, `/browser/summary`, `/browser/state`, `/browser/settle`, `/browser/tabs`, `/browser/profiles`, `/browser/tasks`, `/browser/history`, `/browser/requests`, `/browser/bookmarks`, `/browser/receipts`, `/browser/evidence`, `/browser/privacy`, `/browser/personal-lock`, `/browser/engine-pool`, `/browser/shields`, `/browser/developer-mode`, `/browser/teach/drafts`, `/browser/downloads`, `/browser/uploads`, `/browser/logs`, `/browser/storage-state`, `/browser/dialogs`, `/browser/permissions`, `/browser/popups`, `/browser/network`, `/browser/robots`, `/release-test/tauri-invokes/:id` |
| POST | `/connect`, `/prompt`, `/abort`, `/disconnect`, `/autonomy`, `/state/ui`, `/panels`, `/preview`, `/preview/work/start`, `/preview/work/stop`, `/preview/work/restart`, `/preview/work/diagnose`, `/state/environment/trace_export`, `/state/grok_environment/trace_export`, `/state/session_git/checkpoint`, `/state/session_git/worktree`, `/tools/fs_watch`, `/tools/process_list`, `/tools/process_signal`, `/tools/process_stats`, `/tools/process_attach_stdout`, `/tools/secret_get`, `/settings`, `/sessions/:id/archive`, `/tabs/:id/archive`, `/plan`, `/goal/start`, `/goal/stop`, `/goal/complete`, `/goal/pause`, `/goal/resume`, `/goal/approve`, `/goal/reject`, `/build/start`, `/build/stop`, `/build/complete`, `/build/receipt`, `/build/pause`, `/build/resume`, `/build/recheck_blocker`, `/build/operator_note`, `/build/approve`, `/build/reject`, `/permissions/:reqId/respond`, `/provider-adapters/run`, `/provider-sessions/start`, `/provider-sessions/abort`, `/agent_cli_setup/install/prepare`, `/agent_cli_setup/install/confirm`, `/agent_cli_setup/install/cancel`, `/agent_cli_setup/recheck`, `/diagnostics`, `/github/pr/create`, `/vault/lock`, `/vault/setup/begin`, `/vault/setup/confirm-recovery`, `/vault/remember-device`, `/vault/grants`, `/vault/grants/:grant_id/revoke`, `/vault/agent-requests`, `/vault/agent-requests/:request_id/cancel`, `/vault/get`, `/vault/set`, `/vault/delete`, `/vault/open-panel`, `/vault/e2e/reset`, `/vault/e2e/seed-secret`, `/vault/e2e/probe-use`, `/vault/e2e/approve-grant`, `/vault/e2e/deny-grant`, `/vault/e2e/revoke-grant`, `/vault/e2e/expire-grant`, `/connections`, `/connections/provider-scan`, `/connections/:id/test`, `/tasks`, `/tasks/agent`, `/tasks/provider-catalog`, `/tasks/:task_id/revise`, `/tasks/:task_id/pause`, `/tasks/:task_id/resume`, `/tasks/:task_id/run`, `/tasks/runs/:occurrence_id/cancel`, `/tasks/:task_id/attention/:attention_id/resolve`, `/tasks/:task_id/attention/overflow/resolve`, `/outside-connectors`, `/outside-connectors/:id/test`, `/outside-connectors/:id/simulate`, `/browser/open`, `/browser/tabs/open`, `/browser/tabs/focus`, `/browser/tabs/reorder`, `/browser/tabs/close`, `/browser/tabs/lock`, `/browser/tabs/heartbeat`, `/browser/tabs/unlock`, `/browser/task/start`, `/browser/task/autonomy`, `/browser/task/control`, `/browser/task/finish`, `/browser/action`, `/browser/bookmarks`, `/browser/bookmarks/reorder`, `/browser/rendered-check`, `/browser/logs`, `/browser/privacy`, `/browser/personal-lock`, `/browser/engine-pool`, `/browser/shields`, `/browser/shields/site`, `/browser/developer-mode`, `/browser/developer-mode/approval`, `/browser/developer/inspect`, `/browser/teach/prepare`, `/browser/teach/revise`, `/browser/downloads/request`, `/browser/downloads/complete`, `/browser/uploads/request`, `/browser/uploads/complete`, `/browser/cdp/execute`, `/browser/trace/export`, `/browser/flight-recorder/export`, `/browser/evaluations`, `/browser/har/export`, `/browser/performance/export`, `/browser/recipes/export`, `/browser/recipes/replay`, `/browser/robots/schedule`, `/browser/robots/run`, `/browser/robots/cancel`, `/browser/storage-state/export`, `/browser/dialogs`, `/browser/dialogs/resolve`, `/browser/permissions`, `/browser/permissions/resolve`, `/browser/popups`, `/browser/session-grants/request`, `/browser/session-grants/resolve`, `/browser/session-grants/apply`, `/browser/vault-deposits`, `/browser/vault/fill-receipt`, `/browser/vault/generate-receipt`, `/browser/report`, `/release-test/clipboard`, `/release-test/browser/trusted-vault-fixture`, `/release-test/tauri-invokes`, `/release-test/tauri-invokes/:id/claim`, `/release-test/tauri-invokes/:id/complete` |
| DELETE | `/tools/fs_watch/:watchId`, `/connections/:id`, `/tasks/:task_id`, `/outside-connectors/:id`, `/browser/bookmarks/:bookmark_id`, `/browser/shields/site/:host`, `/release-test/tauri-invokes/:id` |
| GET | `/release-test/native-picker` |
| POST | `/release-test/native-picker` |
| DELETE | `/release-test/native-picker` |

Legacy `/goal/*` endpoints remain wired for old automation, but new
long-horizon automation should use `/build/*` and public UI should present
`/build` as the single command.

### Isolated release-test Tauri relay

The `/release-test/tauri-invokes*` routes are unavailable in ordinary ShellX
instances. They activate only when the process satisfies the exact isolated
release-profile contract (dedicated test home, instance id, marker, and
separate Debug API/MCP ports). The authenticated controller starts one of the
153 frozen allowlisted commands; the backend emits only an invoke id and a
128-bit claim nonce to the renderer. The renderer must claim that nonce before
the backend returns the command and bounded JSON arguments, invokes through the
normal Tauri bridge, and submits a bounded result. Only one invoke may be
active, state expires after 60 seconds, and `DELETE` removes terminal state.
Relay arguments, results, and errors are not written to the Debug event ring.

### Isolated release-test clipboard guard

`POST /release-test/clipboard` is unavailable in ordinary ShellX instances.
Its `preflight` action reads only native clipboard format/owner metadata. If
that metadata is empty, the route creates one exact lease that the controller
can release unused. If the clipboard is nonempty, it returns
`409 release_clipboard_not_empty`, creates no lease, and neither reads nor
changes payload bytes. This refusal is a passing preservation outcome for the
installed release driver; the gate never clears an operator clipboard merely
to make a test pass.

### Isolated release-test native picker

`POST`, `GET`, and `DELETE /release-test/native-picker` are unavailable in
ordinary ShellX instances and use the same exact disposable-profile boundary
as the Tauri relay. `POST` accepts one absolute canonical file or directory
inside the release profile, with the strict shape
`release-native-picker-<16 hex>/{attached.txt|vault-keyfile.json|selected-folder}`.
The response and subsequent `GET` expose only the picker kind and a SHA-256
path digest; they never expose the path. `DELETE` clears an unused lease.

The production dialog wrapper first invokes
`release_test_take_native_picker`. Ordinary instances receive `null` and open
the real operating-system dialog. In an isolated release instance, a
kind-matched lease is consumed once and passed through the same production
post-selection handler. Vault keyfile text is bounded to 16 KiB. The macOS
release driver still performs candidate-bound operating-system dialog
selection; Windows and Linux use this isolated one-shot result to exercise the
production handler, while final installed human acceptance separately proves
the native operating-system dialog itself.

### Isolated release-test Browser child-webview fixture

`POST /release-test/browser/trusted-vault-fixture` is unavailable in ordinary
ShellX instances and does not change Browser Developer Mode. It exists because
native desktop WebDriver can bind ShellX's top-level windows but cannot address
the embedded page webview directly. The route accepts no JavaScript, selector,
URL, or secret. Its `prepare` action installs one compiled fixed form only when
the requested task and tab are the exact active owner of a live engine on the
secure `https://example.com` origin. Its `proof` action accepts only the fixed
`password` or `profileEmail` field name and returns presence, SHA-256, and input
event count with `secretExposed: false`; it never returns the field value. The
exhaustive installed-candidate Vault-fill drivers use this bridge only for form
setup and redacted effect observation. Production fill authorization and the
actual Browser action remain unchanged.

## ShellX Vault Routes

ShellX Vault is the default secret authority for ShellX users and agents.
Setup routes return recovery/setup metadata only; secret values are not returned
from agent-facing routes. The in-app Vault backend uses the shared ShellX Vault
broker for resource schemas, grants, safe-folder/project-capsule contracts,
backup/recovery data, and sync-set groundwork while preserving the ShellX UI
and Debug API mediation rules below.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/vault/setup/begin` | Starts local or external Vault setup and returns recovery-kit words plus confirmation id. `rememberDevice` defaults to true. |
| POST | `/vault/setup/confirm-recovery` | Confirms the user saved recovery material, optionally imports existing local ShellX secrets when `importLegacy` is true, and then activates Vault. |
| POST | `/vault/lock` | Local debug/operator route to manually lock Vault without revealing anything. Clears the active session and local plaintext compatibility cache; remembered-device remains configured but manual lock blocks auto-unlock until passphrase unlock. |
| POST | `/vault/remember-device` | Enables or disables OS-backed remembered unlock. Enabling requires `passphrase`; disabling deletes the device credential. |
| GET | `/vault/grants` | Lists grant metadata only. |
| POST | `/vault/grants` | Creates a pending scoped grant for mediated use. Host MCP requires an explicit `actorScope` or `actorKind` and never expands an omitted scope to all ShellX agents. In an ordinary profile, approval is in-app/Tauri-only and agents cannot self-approve. Disposable isolated E2E profiles expose separately gated `/vault/e2e/*` approval fixtures. |
| POST | `/vault/grants/{grantId}/revoke` | Revokes a grant. |
| GET | `/vault/agent-requests` | Lists the bounded executable-request queue, agent-visible resource catalogue, and redacted results. Optional `actorId` filters the queue; Host MCP always binds this filter to its own session. User-only resource metadata is excluded. It never approves a request or returns plaintext values. |
| POST | `/vault/agent-requests` | Queues a digest-bound absolute executable, arguments, optional absolute cwd, and Vault-resource-to-environment bindings for ShellX operator review. It does not execute immediately. |
| POST | `/vault/agent-requests/{requestId}/cancel` | Lets the same actor cancel its own pending request. Approval and denial are unavailable through ordinary-profile HTTP; isolated `/vault/e2e/*` routes are test fixtures, not production approval paths. |
| GET | `/vault/keys` | Lists agent-visible key names plus descriptions in `entries`; secret values are never returned and user-only entries are hidden. |
| GET | `/vault/resources` | Lists agent-visible typed resources in `resources` and `entries`: `secret`, `profileCard`, compatibility `emailInbox`, and `stripeAgentWallet`. Values are never returned; user-only resources are hidden. |
| POST | `/vault/set` | E2E/operator-test only over Debug API (`SHELLX_VAULT_E2E=1` plus disposable `SHELLX_VAULT_PROFILE_DIR`). Stores a value and optional non-secret metadata without echoing the value. User writes use the ShellX UI/Tauri command path. |
| POST | `/vault/get` | Raw reveal is denied on the Debug API and returns `raw_secret_reveal_denied`; use mediated fill/injection routes instead. |
| POST | `/vault/open-panel` | Bearer-authenticated UI mutation that opens the operator Vault panel; it does not reveal or approve a secret. |
| GET/POST | `/vault/e2e/*` | Test-only reset, seed, probe, grant approve/deny/revoke/expire, and audit fixtures. Every route requires `SHELLX_VAULT_E2E=1` plus an absolute disposable `SHELLX_VAULT_PROFILE_DIR` whose live backend identity matches and whose path cannot be the stable user Vault. |
| Tauri | `shellx_vault_lock` | Operator/UI-only manual lock. Clears the active Vault session and local plaintext compatibility cache; remembered-device unlock remains configured but will not auto-unlock until the user enters the master passphrase again. |
| Tauri | `shellx_vault_unlock` | Operator/UI-only passphrase unlock. Re-enables normal remembered-device behavior after a manual lock. |
| Tauri | `shellx_vault_agent_request_center` | Operator/UI-only queue and current resource catalogue. |
| Tauri | `shellx_vault_agent_request_approve` | Trusted operator action: verifies the stored digest and current policy, then runs the exact request on the ShellX desktop host with a cleared environment and only approved bindings. Output and runtime are bounded; exact secret values are redacted. |
| Tauri | `shellx_vault_agent_request_deny` | Trusted operator action: digest-bound denial without execution. |

Vault metadata is a planning surface: agents can see key names and descriptions
for entries that are not marked user-only, then ask the user for a grant when a
matching key already exists. Metadata must describe purpose and permissions, not
contain the secret value. Host MCP exposes the same safe discovery surface as
`vault_list`; raw `secret_get` for `vault:`, `pass:`, and bare legacy
references stays denied unless a separate user-approved reveal path is added.

Grant request body:

```json
{
  "secretRef": "accounts/example-password",
  "operation": "fill",
  "actorScope": {
    "kind": "browserOrigin",
    "origin": "https://accounts.example.com"
  },
  "origin": "https://accounts.example.com",
  "expiresAtMs": 1790000000000
}
```

Supported mediated operations are `fill`, `profileFill`, `emailCodeRead`,
`agentWalletUse`, `injectEnv`, `providerUse`, `connectorUse`, and `deposit`.
`rawReveal` is not part of the agent-facing flow. Pending grants return
`approved: false`; agent use remains denied with `grantPending` until the
operator approves the request in the Vault Request Center.

Host MCP grant requests must name `actorScope` or the `actorKind` shorthand.
`allShellxAgents` remains a supported explicit choice for operator-reviewed
shared access, but it is never selected by omission.

Host MCP `vault_agent_request` provides `request`, `list`, and `cancel`
actions over this queue. `request` requires an absolute program path and at
least one agent-visible Vault resource binding. The broker refuses inline
shell/interpreter evaluation, user-only resources, legacy `pass:` references,
duplicate or loader-altering environment names, oversized arguments, and
timeouts above 15 minutes. Approval always remains a trusted in-app action.
The executable runs on the operating system hosting the ShellX desktop app;
it does not automatically run in the active SSH or WSL environment.
Its larger exact schema is available through targeted `search_tool` discovery,
then invoked with `host_act action=vault_agent_request` and the exact fields
inside `params`. It is not injected into the default advertised catalog.

Not currently wired despite older roadmap text below: `GET /`, `GET /version`,
`GET /state/projects`, `GET /state/preview`, `GET /state/plan`,
`GET /state/panels`, `GET /sessions`, `POST /sessions`,
`GET /sessions/:id`, `DELETE /sessions/:id`, `POST /sessions/:id/switch`,
`POST /sessions/:id/rename`, `GET /autonomy`, `GET /skills`,
`POST /skills/*`, `GET /files`, `POST /files/*`, and `/terminal/*`.

This document does not contain runnable code. It defines what each
endpoint accepts, what it returns, and what gets logged.

---

## ShellX Browser Surface

ShellX Browser is the ShellX-owned local browser runtime. It is intended for
agent-first desktop workflows where ShellX keeps profiles, cookies, session
grants, Vault deposits, and receipts under the user's local control. Provider
agents should use this surface through ShellX observations/refs/actions rather
than receiving browser credentials or raw cookies.

Host MCP advertises eight compact entry tools totaling 7,778 serialized bytes:
`capabilities_summary`, `search_tool`, read-class `host_read`, permission-gated
`host_act`, read-class `browser_read`, permission-gated `browser_act`, read-class
`cut_read`, and permission-gated `cut_act`.
The 98 exact underlying Host schemas remain searchable; the two Host gateways
and two dispatch-only compatibility aliases complete the 107-surface callable
inventory. Every non-Browser/non-Cut handler is mapped into exactly one Host
gateway. Agents query the legacy action name with `search_tool`, then pass its
exact fields inside gateway `params`.
Host text reads are also response-bounded: `host_read` with `action:"fs_read"`
returns 16 KiB by default and includes `offset_bytes`, `bytes_returned`,
`next_offset_bytes`, `truncated`, and `approx_tokens`. Continue with the exact
next offset only when another page is necessary. An explicit page is capped at
1 MiB, so a single tool call cannot inject an unbounded document into the
provider context.

The ShellX Cut pair keeps Cut's generated catalog out of the default provider
prompt. `cut_read action=status` returns the compact typed
`shellx.cut.tooling-status.v1` projection for the installed/running editor;
`action=search` returns a bounded match list and `action=schema` returns one
exact Cut input schema. The catalog is loaded only for those discovery calls
and cached by installed `cutd` executable identity. `cut_act` calls one exact
verb through Cut's existing MCP proxy and the running editor's single engine;
it does not create a second timeline authority. Every `cut_act` call is
write-class and tab-permission-gated because the current Cut `tools/list` does
not publish reliable read-versus-mutation annotations. Direct Cut discovery was
measured from current Cut source at 262 tools and a 294,151-byte JSON-RPC reply,
while each installed Cut version reports its own exact total. The ShellX Cut
gateway itself remains two compact schemas.

The right-rail Tools surface uses that same typed status projection for the
selected session. Its **Check** control probes status only and never opens
ShellX Cut. **Open** is a separate `cut_tooling_open` Tauri action that occurs
only after an explicit operator click. With ShellX tooling exposure enabled,
Local, WSL, and SSH provider sessions all use the parent desktop host: WSL uses
the ShellX host bridge and SSH uses its reverse tunnel. This does not turn the
generated Cut catalogue into an always-advertised or right-rail payload.

The Browser pair replaces a 32-tool, 82,893-byte advertised catalog with a
two-tool, 2,601-byte catalog. The named `browser_*` tools remain
callable compatibility aliases and their exact schemas remain available through
targeted `search_tool` queries, but they are not injected into every provider
prompt. Agents should treat the routed tools as the native ShellX Browser web
surface: use `browser_read action=tabs`, `browser_act action=navigate`, then
`browser_read action=observe` for refs. Use `browser_act action=runSteps` for
short generic action sequences when that reduces MCP round trips without site
hardcoding, including safe in-page `findText` and
`extractTable` steps, plus ordinary `scroll`, `select`, `goBack`, `goForward`,
and `reload` steps. In `browser_run_steps`, `findText` may use `query` as a
convenience alias and Host MCP maps it to the Browser action `value` field.
`continueOnError` controls execution flow only: later steps are attempted, but
the aggregate remains `ok:false` / `isError:true` if any step fails. The result
separately reports success/failure counts, whether execution continued after a
failure, and a compact `failureSummary`; `stoppedAt` is reserved for an early
stop. Act on refs or stable selectors from fixtures/saved workflows/prior
observations, use
`browser_act action=fillFromVault` for grant-approved credential fills, resolve
task-owned beforeunload prompts with `browser_act action=resolveDialog`, then verify,
capture page evidence, extract page text/markdown/table data with
`browser_read action=extract`, or export a redacted trace. When API keys, generated
passwords, or tokens are visible on a page, `browser_read action=observe` may return
redacted `secret-*` refs; agents should pass those refs to
`browser_act action=captureSecretToVault` with a durable Vault ref instead of reading
clipboard/raw values. For rich editors or canvas surfaces that have no usable
DOM ref, agents can use `browser_act action=screenshot` to choose viewport CSS coordinates
and then `browser_act action=clickAt` / `browser_act action=typeText`; normal inputs should still
use refs. If a visible ref click reports applied but a Google-style menu/page
state does not change, retry the same ref with `browser_click_ref force=true`
to dispatch native pointer input. Host MCP can also recover stale click refs
through strict `stepSummary.locatorCandidates` selectors, or perform this retry
automatically when a normal click fails solely on `receivesEvents`; the returned
structured result includes `mcpRecovery` evidence when that happens. For split
buttons/dropdowns where the whole button ref still does not change state, use
full-page screenshot evidence and coordinate-click the visible arrow/subtarget.
Observation refs are deterministic for unchanged controls and carry an opaque
`fingerprint`. If the live selector now resolves to a semantically different
element, ShellX returns `staleRef` with a failed `fingerprint` check and does not
act; agents must re-observe and use the replacement ref. `force=true` never
bypasses this identity check.

Repeatable attempt evidence stays inside the same routed surface:
`browser_act action=flightRecorderExport` writes a bounded redacted attempt,
`browser_act action=evaluationWrite` verifies exact attempt byte/hash/schema/
scope identities and writes the deterministic report, and
`browser_read action=evidence` lists only the current caller session's bounded
recent identities. The two write actions remain permission-gated; their larger
exact schemas are search-only compatibility specs.

Developer inspection also stays inside the compact pair. `browser_read
action=developerInspect` runs one fixed, Developer Mode-gated native inspection
for a caller-owned task and returns at most 3,072 bytes of sanitized document,
console, network, performance, and deterministic issue summaries. Callers
cannot supply JavaScript, CDP methods, headers, cookies, bodies, storage reads,
or an external-Chrome target. The desktop Evidence panel uses an operator-only
Tauri adapter for the fuller 32 KiB view and separate **Export HAR** and
**Export performance** actions; those export buttons return receipt identity,
bytes, and SHA-256 only, never the private artifact path.

Browser Teach turns a complete, caller-owned Flight Recorder attempt from a
completed task into a deterministic review draft. `browser_act
action=teachPrepare` accepts
`attemptId`; `browser_read action=teachDrafts` accepts `taskId` and an optional
`limit` from 1 to 20 and returns only compact draft identities. The authenticated
Debug API additionally exposes prepare, list, and compare-and-swap revise
routes. Recipe approval and dry-run rehearsal are operator-owned Tauri actions
inside the Evidence panel and are absent from Host MCP and raw HTTP. Approval
requires the exact current revision ID/hash, resolved blocking issues, safe
query-free navigation values, and any required opaque Vault binding references;
it writes an ordinary Action Recipe V2 but does not run it. Rehearsal accepts
the exact approved recipe ID/hash, calls the existing dry-run planner, returns
no artifact path, and always reports `stepsApplied: 0`. After an exact
zero-skip rehearsal, the operator can open a paused Task Manager draft. ShellX
persists one idempotent workflow bookmark with the private recipe path kept in
Browser state, then hands the main workspace only the workflow ID/digest,
source-session identity, goal, and required Vault key identities. No Task is
saved, provider selected, or schedule enabled until the user reviews it. The
main workspace rebinds that window event to the exact native receipt, owning
Browser task, and durable workflow bookmark before displaying the draft.

Taskless Host MCP Browser mutations create or reuse a `task-disposable` task
bound to the calling ShellX MCP tab/session. A different MCP session cannot act
on or control that bound task implicitly; agents must pass an explicit `taskId`
when deliberately joining a human-agent cowork task. The Host transport stamps
its caller identity on direct actions, batches, applied workflow replays, task
control, autonomy changes, and task-owned dialog resolution. The internal
`x-shellx-mcp-caller-id` header is a cooperative session-isolation mechanism,
not a replacement for Debug API bearer authentication; possession of the
loopback bearer token remains the general raw HTTP security boundary. The
evidence read/export/evaluation routes additionally require the bounded
`x-shellx-mcp-caller-id` injected by a ShellX-owned agent session. The desktop
Evidence panel uses operator-only Tauri IPC instead of falling back to
headerless HTTP operator authority. An absent caller header continues to mean
an explicit bearer-authenticated operator request; any present malformed,
empty, overlong, or duplicate caller header is rejected before every
`/browser/*` handler and cannot be reinterpreted as headerless operator scope.
Caller-scoped summary, task, History, request, check, and settle revisions are
derived only from that caller session's task-owned Browser state; other agent
or Personal Browser activity cannot advance those polling cursors.
For coordinate work, prefer
`browser_screenshot` with `fullPage:true`:
the response includes `pageWidth`/`pageHeight` and the MCP summary includes
`pageSize`/`cssScale` so agents can divide screenshot pixels by the scale before
calling `browser_click_at` or `browser_type_text`. Coordinate clicks are still
CSS viewport actions: after a resize/minimize/restore, take a fresh screenshot;
for a target below the current viewport, scroll it into view and recapture before
clicking. If the page itself asks to
clear application resources, `browser_clear_site_data` clears browser cache plus
non-cookie storage for the current origin and reloads. If a site still asks to
clear cookies after that, agents should request user approval before any
sign-in-resetting cleanup. These tools call the routes below; the MCP layer does
not
own a second browser engine or a separate policy model.
`browser_read action=observe` enforces a 3,000-byte serialized structured-result
budget by default, and its final MCP tool envelope is regression-tested below
4,000 bytes even for a synthetic heavy page. It reports `mcpSerializedBytes`
and `mcpApproxTokens`; `fullObservation=true` is the explicit unbudgeted escape
hatch. Together with the general Host gateways, the always-advertised MCP
catalog is now bounded to 7,778 bytes instead of roughly 51.7 KB without
removing exact handlers. Page-mutating Browser MCP calls and trace exports
remain write-class host tools
and require the same ShellX MCP write gate as other host mutations.
Agents should not dump raw `/browser/state` or Browser observation JSON into
the current working directory, Downloads, or other user folders for evidence.
Use `browser_trace_open` for bounded redacted diagnostics and
`browser_save_page` only for user-requested page content.

Agent environments running from the ShellX source package can use its CLI fallback when MCP is not
the active surface: `pnpm shellx-browser run-steps --steps-json '[{"action":"navigate","url":"https://example.com"},{"action":"waitFor","value":"Example Domain"}]'`.
The same CLI exposes `flight-recorder-export` and `workflow-evaluate`;
evaluation requires an explicit fixed `--evaluated-at-ms` and exits nonzero
when `evidenceComplete` is not true while still printing the report identity.
Those evidence commands require the CLI to have been launched for a ShellX
agent session, which supplies `SHELLX_HOST_MCP_TAB_ID`; a standalone CLI with
only the shared Debug API token cannot acquire operator evidence authority.
By default, `run-steps` starts an `agent-work` Browser task so agent batches do
not act on the operator's active personal tab. Use `--task`/`--tab` for an
explicit target, or `--use-active-tab` only for deliberate manual active-tab
work. It follows the same generic-step contract and keeps sensitive
Browser/Vault actions on dedicated gated tools. A failed batch prints its
structured result and exits nonzero, including when `--continue-on-error` ran
later steps.
Direct installed CLI fallbacks also exist for visual-only controls and
current-origin recovery: `pnpm shellx-browser click-at 128 240 --task
<taskId>`, `pnpm shellx-browser type-text 128 240 "hello" --task <taskId>`,
and `pnpm shellx-browser clear-site-data --task <taskId>`.
Site-data recovery preserves cookies/sign-in. WebView2 also clears its HTTP
cache; WebKit clears origin-scoped Cache Storage, IndexedDB, local/session
storage, and service workers before reloading.
`workflow-replay` returns a compact `summary` beside the raw `replay` response
so agents can inspect step counts, skipped reasons, and decision-point totals
without parsing the full recipe replay payload first.

### HTTP Debug API Browser flow for outside drivers

The MCP names above are for agents running inside ShellX. Outside drivers
should prefer the ShellX-owned Browser CLI, which performs private loopback
discovery and authentication without placing bearer values in shell history,
arguments, or logs. Custom clients still use the raw `/browser/*` routes and
the `Authorization: Bearer <token>` protocol, but must obtain that credential
through a private process-local integration.

Minimal outside-driver loop:

```bash
pnpm shellx-browser tabs
pnpm shellx-browser snapshot
pnpm shellx-browser run-steps --steps-json \
  '[{"action":"navigate","url":"https://example.com"},{"action":"observe"}]'
```

`browser_read` and `browser_act` route to the same operations below. The legacy
names document the exact MCP-to-HTTP mapping and remain callable compatibility
aliases:

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
- `browser_use_agent_wallet -> POST /browser/action` with `action: "useAgentWalletGrant"`, `grantId`, and `resourceRef`; the current release returns `browser_agent_wallet_checkout_unavailable` until a provider transaction bridge can prove the checkout.
- `browser_downloads -> GET /browser/downloads`.
- `browser_resolve_dialog -> POST /browser/dialogs/resolve` with `dialogId`, `taskId`, and `action: "accept"` or `"dismiss"`.
- `browser_trace_open -> POST /browser/trace/export`.
- `browser_workflows -> GET /browser/bookmarks` and filter rows with `agentWorkflow`.
- `browser_workflow_save -> POST /browser/recipes/export`, then `POST /browser/bookmarks` with `agentWorkflow`.
- `browser_workflow_replay -> POST /browser/recipes/replay`.
- `browser_run_steps -> repeated POST /browser/action` calls using the same task/tab context, or the bundled `pnpm shellx-browser run-steps` helper when shell access is available.

Raw HTTP callers still cannot self-approve operator-only actions. Vault grants,
session grants, permission prompts, unsafe downloads/uploads, Developer Mode,
privacy/Shields writes, and Personal Browser Lock changes remain mediated by
the ShellX UI/Tauri operator path.

Before any page mutation, ShellX classifies the current stored observation and
the proposed action with the local fixed-vocabulary Browser prompt-injection
guard. The guard covers direct actions, saved workflow/Robot replay, Browser
Teach rehearsal/apply, scheduled Task Browser work, and the operator Vault-fill
path before any Vault read or WebView effect. It returns bounded
`allow`/`warn`/`block` evidence with separate `inboundContentVerdict` and
`proposedActionVerdict`, confidence, policy version, task/tab/origin scope, and
a receipt. Receipts contain finite signal/channel IDs; page text, selectors,
typed values, action URLs, and secrets are never retained. A missing or stale
observation pauses mutations with `requiredApproval:"promptInjectionReview"`;
read/observe/recovery actions and first navigation into an empty tab remain
available. Direct actions and applied recipe replay perform one visible
fresh-observation recovery before stopping the current and remaining steps. An operator may use the exact
blocked receipt for one origin/task/action-scoped retry within five minutes;
the receipt is consumed once and Host MCP callers cannot self-approve it.

ShellX Host MCP attaches an authenticated caller identity to Browser reads.
Summary, check/settle, tabs, tasks, profiles, history, requests, transfers,
receipts, logs, and network rows are filtered to that caller's task-owned
Browser context. Personal and other-agent activity remains available to the
local operator UI. Bookmark reads expose the Agent workflow catalog rather
than personal links. A caller must also prove one exact caller-owned task/tab
pair before any Browser action reaches Vault mediation or the native WebView.
Direct Debug API access without the Host MCP caller header is the local
operator/debug view and uses the full registry described below.

Read routes:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/browser/summary` | Bounded agent/UI orientation under 16 KB: contract revisions, active task/tab/engine, collection counts, and at most ten bounded pending requests. It never contains prior observations, receipts, network rows, history, or console logs. |
| GET | `/browser/check?taskId?&browserTabId?&timeoutMs?` | Quiet check combining the bounded summary with a tiny settlement snapshot. It never creates a task, opens/focuses the Browser window, mounts an engine, navigates, observes DOM, or emits a receipt. Use for agent-only liveness/settlement checks; use the visible Browser when rendered-page evidence or interaction is required. |
| POST | `/browser/rendered-check` | `{ url, expectText?, titleIncludes?, selector?, caseSensitive?, timeoutMs?, settleMs?, expectedDomains? }`; loads one page in a bounded incognito hidden renderer and returns redacted rendered evidence. It creates no Browser task/tab, uses no personal cookies, opens no user-visible window, emits no receipt, persists no profile, blocks cross-origin fetch/XHR/WebSocket/beacon calls, injects a restrictive CSP, blocks downloads/popups, and destroys the renderer after the call. It is not a general network sandbox. Private/local targets require matching `expectedDomains`. Use the visible Browser for authenticated, interactive, approval-bearing, or human-cowork work. |
| GET | `/browser/state` | Compatibility full-state response. Browser UI uses `?view=core`, which excludes observations and heavy history/activity/request collections, then fetches visible slices separately. New agent clients should start with `/browser/summary`. |
| GET | `/browser/settle?taskId?&browserTabId?&timeoutMs?` | Tiny engine/task settlement snapshot. With `timeoutMs`, the server waits internally and returns one bounded response instead of requiring clients to poll full Browser state. |
| GET | `/browser/tabs` | Browser tabs with active tab, profile, task binding, user/agent/delegated owner state, lock state, storage root, and privacy mode. |
| GET | `/browser/profiles` | Small owned profile set: `personal`, `agent-work`, `task-disposable`. |
| GET | `/browser/tasks?detail=summary|full&includeObservation=false&limit=200` | Summary is the default. Full task detail remains bounded by `limit`; prior `lastObservation` data is included only when explicitly requested. |
| GET | `/browser/history?limit=500` | Bounded Browser history slice for the visible History panel. |
| GET | `/browser/requests` | Browser request-center slice: session grants, deposits, dialogs, and permissions. |
| GET | `/browser/bookmarks` | Persistent bookmark tree plus toolbar view, including links, folders, pins, and workflow metadata; no page storage values. |
| GET | `/browser/receipts?limit=200` | Most recent browser receipts. |
| GET | `/browser/privacy` | Current global/profile ad mode settings and low-entropy identity policy. |
| GET | `/browser/personal-lock` | Current Personal Browser Lock state: enabled flag, timeout, auth mode, locked flag, and redacted PIN-configured flag. Mutations are operator/Tauri-only. |
| GET | `/browser/engine-pool` | Current native Browser engine concurrency pool limits and background-mode policy. |
| GET | `/browser/shields` | Current Browser Shields defaults and per-site overrides; no cookies, storage values, headers, or bodies. |
| GET | `/browser/downloads` | Explicit Browser download intent records. |
| GET | `/browser/uploads` | Explicit Browser upload intent records. |
| GET | `/browser/logs?limit=200` | Most recent Browser console/runtime logs for agent-readable page diagnostics. |
| GET | `/browser/storage-state?profileId?` | Safe profile storage manifest: roots, retention, cookie/local-storage policy, grant status, no values. |
| GET | `/browser/dialogs?limit=200` | Dialog events with type, text, safe URL, status, and prompt-value presence only. |
| GET | `/browser/permissions?limit=200` | Page permission events with kind, safe origin/path, status, approval flag, and query/fragment redaction flags. |
| GET | `/browser/popups?limit=200` | Popup/new-window requests with safe target URL, query/fragment redaction flags, and no reusable full-URL hash. |
| GET | `/browser/network?limit=200` | Safe network metadata: origin/path URL, method, load status, privacy decision, no headers or bodies. |
| GET | `/browser/robots?limit=200` | Scheduled Browser robot/work-queue jobs and their receipt-backed status. |

Action routes:

| Method | Path | Body |
| --- | --- | --- |
| POST | `/browser/open` | `{ startUrl? }` |
| POST | `/browser/tabs/open` | `{ taskId?, profileId?, url? }` |
| POST | `/browser/tabs/focus` | `{ browserTabId, lockLeaseId?, ownerAgentId?, ownerRunId? }` |
| POST | `/browser/tabs/reorder` | `{ browserTabIds: string[] }`; listed tabs move to the front in the supplied order and omitted tabs keep their relative order. |
| POST | `/browser/tabs/close` | `{ browserTabId, lockLeaseId?, ownerAgentId?, ownerRunId? }` |
| POST | `/browser/tabs/lock` | `{ browserTabId, ownerAgentId, ownerRunId, ttlSeconds?, scope? }` |
| POST | `/browser/tabs/heartbeat` | `{ browserTabId, leaseId, ownerAgentId?, ownerRunId?, ttlSeconds? }` |
| POST | `/browser/tabs/unlock` | `{ browserTabId, leaseId?, ownerAgentId?, ownerRunId? }` |
| POST | `/browser/task/start` | `{ goal, startUrl?, profileId?, autonomy?:"assistedAutonomous", expectedDomains?, blockedDomains? }`. A valid Host MCP caller header creates an Agent task bound to that exact session; a headerless bearer-authenticated request creates an operator task. Browser task policy is fixed to truthful assisted autonomy; omitted or `assistedAutonomous` is accepted. Legacy labels return HTTP 403 with `browser_task_autonomy_policy_fixed` before task state is created, and in-memory legacy autonomy labels are normalized when state invariants are repaired. If native engine synchronization fails, ShellX returns HTTP 500 with `browser_task_engine_sync_failed` plus rollback evidence after aborting the provisional task, closing its tabs and unused engine webviews, restoring the previously active tab, and attempting to resync that prior engine. |
| POST | `/browser/task/autonomy` | Compatibility denial path. Task autonomy cannot change after creation; returns HTTP 403 with `browser_task_autonomy_policy_fixed`. |
| POST | `/browser/task/control` | `{ taskId?, action:"pause"|"resume"|"abort"|"userTakeover", reason? }`. A Host MCP caller may control only its exact bound task and cannot claim `userTakeover`; a headerless bearer-authenticated operator request has the trusted lifecycle authority documented below. Caller-supplied `requestedBy` is ignored. |
| POST | `/browser/task/finish` | `{ taskId?, status?:"completed"|"blocked"|"aborted", reason? }`. A Host MCP caller may finish only its exact bound task and cannot finish it while the user owns control; a headerless bearer-authenticated operator request may finish it. Caller-supplied `requestedBy` is ignored. |
| POST | `/browser/action` | `{ browserTabId?, taskId?, action, url?, selector?, refId?, value?, key?, grantId?, secretRef?, sensitiveKind?, approvalId?, lockLeaseId?, ownerAgentId?, ownerRunId?, fullPage? }` |
| POST | `/browser/bookmarks` | `{ bookmarkId?, label, kind?, parentId?, url?, category?, toolbarPinned?, toolbarOrder?, agentWorkflow? }`; `kind` is `link` or `folder`. `agentWorkflow` is experimental metadata for reusable agent workflow bookmarks. |
| POST | `/browser/bookmarks/reorder` | `{ items: [{ bookmarkId, parentId?, toolbarPinned?, toolbarOrder? }] }`; rejects folder cycles. |
| DELETE | `/browser/bookmarks/:bookmark_id` | Delete a bookmark; deleting a folder also removes its children. |
| POST | `/browser/logs` | `{ taskId?, level, source?, message, url?, line?, column?, details? }` |
| POST | `/browser/privacy` | Debug API denial path for operator-owned privacy/ad-mode writes; returns `browser_privacy_requires_operator`. |
| POST | `/browser/personal-lock` | Debug API denial path for Personal Browser Lock writes; returns `browser_personal_lock_requires_operator`. |
| POST | `/browser/engine-pool` | `{ configuredParallelAgents?, automationMode?:"normal"|"backgroundOnly" }`; updates native Browser engine pool policy. `backgroundOnly` remains an experimental compatibility surface and is hidden from the UI until ShellX has a genuinely non-presentational engine. |
| Tauri | `shellx_browser_control_task` | Operator/UI-only `{ request: { taskId?, action:"pause"|"resume"|"abort"|"userTakeover", reason? } }`. The UI requires a trusted user event before invoking this command. |
| Tauri | `shellx_browser_finish_task` | Operator/UI-only `{ taskId?, status?:"completed"|"blocked"|"aborted", reason? }`. The UI requires a trusted user event before invoking this command. |
| Tauri | `shellx_browser_send_cowork_prompt` | Browser UI-only `{ request: { taskId?, targetTabId, prompt, startUrl?, profileId?, autonomy? } }`. Starts or reuses a task bound to `targetTabId`, syncs its visible Browser engine, and queues a one-time prompt claim for the main ShellX session. Existing tasks must be running and owned by that session. |
| Tauri | `shellx_browser_claim_cowork_prompt` | Main-window internal `{ requestId }`. Consumes the authoritative Rust-held prompt once; renderer events carry only this expiring ID and cannot substitute prompt text. |
| Tauri | `shellx_browser_replay_cowork_prompt_notifications` | Main-window internal recovery hook. Re-emits only pending request IDs after the listener is registered, closing the main-window load/reload race without exposing prompt text to renderer events. |
| Tauri | `shellx_browser_update_privacy` | Operator/UI-only `{ request: { globalAdMode?, profileId?, profileAdMode? } }`, where user-facing modes are `off`, `balanced`, and `strict`. Debug API `POST /browser/privacy` is forbidden with `browser_privacy_requires_operator`. |
| Tauri | `shellx_browser_update_personal_lock` | Operator/UI-only `{ request: { enabled?, timeoutMinutes?, authMode?, blurLockedTabs?, pauseDelegatedTabsWhenLocked?, action?, pin?, newPin?, trustedUserActivity? } }`. Debug API `POST /browser/personal-lock` is forbidden with `browser_personal_lock_requires_operator`. |
| Tauri | `shellx_browser_delegate_tab_to_agent` | Operator/UI-only `{ request: { browserTabId, taskId, reviewFingerprint, grantId?, reason? } }`; atomically revalidates the opaque page/profile/ownership/task review fingerprint before handing a user-owned tab to a nonterminal Browser task, without creating a Vault grant. |
| Tauri | `shellx_browser_take_back_tab_from_agent` | Operator/UI-only `{ request: { browserTabId, reason? } }`; returns a delegated tab to personal user control without revealing Vault secrets. |
| POST | `/browser/shields` | Debug API denial path for operator-owned global Shields writes; returns `browser_shields_requires_operator`. |
| POST | `/browser/shields/site` | Debug API denial path for operator-owned per-site Shields writes; returns `browser_shields_requires_operator`. |
| DELETE | `/browser/shields/site/:host` | Debug API denial path for operator-owned per-site Shields deletion; returns `browser_shields_requires_operator`. |
| Tauri | `shellx_browser_update_shields` | Operator/UI-only `{ request: { enabled?, adTrackerMode?, cookieMode?, fingerprintingMode?, httpsUpgradeEnabled?, scriptBlockingEnabled? } }` for global Shields defaults. Debug API `POST /browser/shields` is forbidden with `browser_shields_requires_operator`. |
| Tauri | `shellx_browser_update_site_shields` | Operator/UI-only `{ request: { host, adTrackerMode?, cookieMode?, fingerprintingMode?, httpsUpgradeEnabled?, scriptBlockingEnabled? } }` for one host override. Debug API `POST /browser/shields/site` is forbidden with `browser_shields_requires_operator`. |
| Tauri | `shellx_browser_remove_site_shields` | Operator/UI-only `{ request: { host } }` to remove one host override. Debug API `DELETE /browser/shields/site/:host` is forbidden with `browser_shields_requires_operator`. |

`POST /browser/open` runs native window initialization behind a 12-second
circuit breaker. A timed-out opener returns HTTP `504` with
`browser_window_open_timeout`; another request while that opener is still
running returns HTTP `409` with `browser_window_open_in_progress`. Both errors
include retryability plus low-entropy platform, WebView backend, display/session
bus presence, and native-versus-WSL/WSLg classification. A late opener keeps
the circuit lock until it exits, so retries cannot create duplicate Browser
windows. If that late operation created a new native window, ShellX closes it
and confirms the window label is absent before releasing the lock; a late
operation that only focused an existing window never closes that user-owned
window and does not apply the timed-out `startUrl`. Native Browser `Destroyed`
events synchronously reconcile `windowOpen`, mounted-engine availability, and
affected tab engine state while preserving task, URL, bounds, and waitlist
state for a later reopen.
| GET | `/browser/developer-mode` | Read current Browser Developer Mode policy, full-CDP flag, and approved hosts. |
| POST | `/browser/developer-mode` | Debug API denial path for operator-owned Developer Mode writes; returns `developer_mode_requires_operator`. |
| POST | `/browser/developer-mode/approval` | Debug API denial path for operator-owned Developer Mode host approvals; returns `developer_mode_requires_operator`. |
| Tauri | `shellx_browser_update_developer_mode` | Operator/UI-only `{ request: { enabled?, fullCdpAccess?, policyDisabled?, approvedHosts? } }`. Debug API `POST /browser/developer-mode` is forbidden with `developer_mode_requires_operator`. |
| Tauri | `shellx_browser_approve_developer_mode_host` | Operator/UI-only `{ request: { host?, currentUrl?, taskId?, fullCdpAccess? } }`. Debug API `POST /browser/developer-mode/approval` is forbidden with `developer_mode_requires_operator`. |
| POST | `/browser/developer/inspect` | Caller-session-bound `{ taskId, browserTabId? }`; runs the fixed native inspection only after Developer Mode/full-CDP preflight and returns a sanitized 32 KiB maximum response. No caller-supplied CDP method or script is accepted. |
| Tauri | `shellx_browser_operator_developer_inspect` | Operator/UI-only `{ request: { taskId, browserTabId? } }`; returns the same sanitized inspection contract to Browser Evidence without manufacturing an MCP caller identity. |
| Tauri | `shellx_browser_operator_export_har` | Operator/UI-only `{ request: { taskId?, browserTabId?, reason? } }`; writes the existing sanitized private HAR artifact and returns only `{ kind, artifactId, receiptId, bytes, sha256, createdAtMs, entries? }`. |
| Tauri | `shellx_browser_operator_export_performance` | Operator/UI-only `{ request: { taskId?, browserTabId?, reason? } }`; writes the existing sanitized private performance artifact and returns the same path-free compact receipt shape. |
| POST | `/browser/downloads/request` | `{ taskId?, browserTabId?, url, fileName?, destinationDir?, reason }` |
| POST | `/browser/downloads/complete` | `{ transferId, finalPath, mimeType?, bytes, sha256, sourceUrl?, destination?, retentionReason, approvalId }` |
| POST | `/browser/uploads/request` | `{ taskId?, browserTabId?, filePath, displayName?, destinationOrigin?, refId?, reason }` |
| POST | `/browser/uploads/complete` | `{ transferId, finalPath?, mimeType?, bytes, sha256, sourceUrl?, destination?, retentionReason, approvalId }` |
| Tauri | `shellx_browser_grant_transfer` | Operator/UI-only `{ request: { transferId, direction, origin?, sha256?, ttlSeconds? } }`; mints the approval token required by transfer completion. |
| POST | `/browser/cdp/execute` | `{ taskId?, browserTabId?, method, params?, expression?, reason? }`; requires Developer Mode full CDP approval for the active host. |
| POST | `/browser/trace/export` | `{ taskId?, browserTabId?, reason? }` |
| POST | `/browser/flight-recorder/export` | Development-only `{ taskId?, browserTabId?, reason?, suiteId?, attemptIndex?, group? }`; task-owner/session bound, bounded, and redacted. |
| POST | `/browser/har/export` | `{ taskId?, browserTabId?, reason? }`; writes a redacted HAR artifact without headers, bodies, cookies, query strings, or fragments. |
| POST | `/browser/performance/export` | `{ taskId?, browserTabId?, reason? }`; writes sanitized navigation/resource timing metrics. |
| POST | `/browser/recipes/export` | `{ taskId?, browserTabId?, reason? }`; converts recent receipts into a redacted replay recipe. |
| POST | `/browser/recipes/replay` | `{ taskId?, browserTabId?, recipePath?, recipe?, dryRun?, reason? }`; dry-runs by default, or applies saved navigation/click/wait/select/press/verify route steps when `dryRun:false`; a path-based saved recipe must byte-for-byte match its in-session `browserRecipeExported` receipt (path, byte count, SHA-256, source, recipe, and task identity), while changed or unreceipted artifacts fail closed; redacted, live-bound, or unsupported steps are skipped with reasons, and an applied replay with skips returns `ok:false`, `status:"incomplete"`. |
| POST | `/browser/teach/prepare` | Caller-session-bound `{ attemptId }`; verifies one complete private Flight Recorder artifact and returns its deterministic Teach bundle, current revision, and draft summary. |
| GET | `/browser/teach/drafts?taskId=<id>&limit=<n>` | Caller-session-bound bounded list of current Teach draft identities; default 8, hard cap 20, with no private artifact paths. |
| POST | `/browser/teach/revise` | Caller-session-bound compare-and-swap revision using `{ draftId, expectedRevisionId, expectedRevisionSha256, goal?, orderedStepIds?, valueEdits?, vaultBindings?, requiredCapabilities?, ambiguityResolutions?, revisionNote? }`. It creates an immutable revision and never approves or runs a recipe. |
| Tauri | `shellx_browser_operator_prepare_teach_draft` | Operator/UI-only `{ request: { attemptId } }` adapter for the Evidence panel. |
| Tauri | `shellx_browser_operator_list_teach_drafts` | Operator/UI-only `{ taskId, limit? }` bounded list adapter. |
| Tauri | `shellx_browser_operator_revise_teach_draft` | Operator/UI-only `{ request: { draftId, expectedRevisionId, expectedRevisionSha256, ...edits } }` compare-and-swap revision adapter. |
| Tauri | `shellx_browser_operator_approve_teach_draft` | Operator/UI-only `{ request: { draftId, revisionId, revisionSha256 } }`; writes a private Action Recipe V2 plus approval receipt and does not execute it. |
| Tauri | `shellx_browser_operator_rehearse_teach_recipe` | Operator/UI-only `{ request: { recipeId, sha256 } }`; requires matching approval and export receipts, runs the existing planner with `dryRun:true`, returns a compact receipt, and applies zero steps. |
| Tauri | `shellx_browser_operator_prepare_teach_task_handoff` | Operator/UI-only `{ request: { draftId, revisionId, revisionSha256, recipeId, recipeSha256, approvalId, rehearsalReceiptId } }`; requires the exact current revision, approval/export receipts, and a zero-skip rehearsal. It persists an idempotent Browser workflow bookmark and returns a path-free handoff for a paused Task Manager draft. |
| POST | `/browser/robots/schedule` | `{ taskId?, browserTabId?, recipePath?, runAtMs?, kind?, reason }`; records a receipt-backed recipe job and due-time metadata. |
| POST | `/browser/robots/run` | `{ jobId, dryRun? }`; executes the saved recipe dry-run or live replay before setting the job's terminal status. |
| POST | `/browser/robots/cancel` | `{ jobId, reason? }` |
| POST | `/browser/storage-state/export` | `{ profileId?, reason? }` |
| Tauri | `shellx_browser_clear_history` | Operator/UI-only `{ request: { scope: "user" | "agent" | "all" } }`. User and Agent remove only their selected partition; the Browser UI presents a dedicated confirmation before All. Agent `clearHistory` stays blocked with `destructiveActionApproval`; registry mutation without the operator path returns `browser_destructive_action_requires_operator`. |
| POST | `/browser/dialogs` | `{ taskId?, browserTabId?, dialogType, text, url?, requiresApproval? }` |
| POST | `/browser/dialogs/resolve` | Agent may resolve only its own pending `beforeunload` dialog for an agent-owned non-personal task tab using `{ dialogId, taskId, action: "accept" | "dismiss" }`. Operator-owned, personal/delegated, prompt, confirm, and permission decisions return `browser_prompt_resolution_requires_operator`. |
| Tauri | `shellx_browser_resolve_dialog` | Operator/UI-only `{ request: { dialogId, action?, promptValue?, approvalId? } }`; applies accepted beforeunload navigation when relevant. |
| POST | `/browser/permissions` | `{ taskId?, browserTabId?, permissionKind, url?, userInitiated?, requiresApproval? }` |
| POST | `/browser/permissions/resolve` | Debug API denial path for operator-owned decisions; returns `browser_prompt_resolution_requires_operator`. |
| Tauri | `shellx_browser_resolve_permission` | Operator/UI-only `{ request: { permissionId, action?, approvalId? } }`; `action` is `grant`, `deny`, or `dismiss`. |
| POST | `/browser/popups` | `{ taskId?, browserTabId?, openerUrl?, targetUrl, disposition?, requiresApproval? }` |
| POST | `/browser/session-grants/request` | `{ taskId?, fromProfileId, toProfileId, reason, ttlSeconds? }` |
| POST | `/browser/session-grants/resolve` | Debug API denial path for operator-owned decisions; returns `403` with `browser_session_grant_resolution_requires_operator`. |
| Tauri | `shellx_browser_resolve_session_grant` | Operator/UI-only `{ grantId, approved }`; grants or denies a requested browser session grant. |
| Tauri | `shellx_browser_open_vault_panel` | Browser UI-only bridge that opens or focuses the main window, requests its existing Vault panel, and returns success only after the renderer acknowledges the exact bounded request after render. Missing listeners and failed delivery time out as errors instead of reporting a false open. |
| POST | `/browser/session-grants/apply` | `{ grantId, taskId? }`; only succeeds after a host-approved grant. |
| POST | `/browser/vault-deposits` | `{ taskId?, label, secretValue, sourceUrl? }`; validates bounded metadata and a secret of at most 4,096 bytes before Vault access, writes to a UUID-owned Vault ref, then commits one redacted Browser receipt with `vaultRef`, opaque per-deposit `storageCommitHash`, and `secretExposed:false`. |
| POST | `/browser/vault/fill-receipt` | Compatibility denial path. Callers cannot self-issue fill receipts; returns `409 browser_vault_receipt_requires_verified_operation`. Verified fills emit receipts internally. |
| POST | `/browser/vault/generate-receipt` | Compatibility denial path. Callers cannot self-issue generation receipts; returns `409 browser_vault_receipt_requires_verified_operation`. Use permission-gated Host MCP `vault_generate` to generate and create-only store a secret. |
| POST | `/browser/report` | `{ taskId?, title, body }` |

`/browser/action` currently accepts `navigate`, `observe`, `extractText`,
`extractMarkdown`, `goBack`, `goForward`, `reload`, `clickRef`, `fillRef`,
`press`, `click`, `type`, `scroll`, `waitFor`, `select`, `uploadFile`,
`downloadFile`, `extractTable`, `captureScreenshot`, `verify`, `findText`,
`clearSiteData`, `capturePageSecretToVault`, `fillFromVaultGrant`,
`fillProfileCardGrant`, `readEmailCodeGrant`, `useAgentWalletGrant`,
`requestSessionGrant`, `createVaultDeposit`, `writeReport`, `askUser`,
`bookmarkCurrent`, `clearHistory`, `submitFinal`, `delete`, and
`requestFinalActionApproval`.
When the native Browser engine is mounted, observation/extraction and
deterministic DOM controls use the child webview. Actions can target a direct
`selector` or a `refId` returned by `observe`. Unsupported or engine-missing
actions return `requiresEngine`; selectorless DOM actions return an honest
`notFound` rather than fake success. `bookmarkCurrent` saves the active task URL
into the Browser bookmark list and emits `browserBookmarkSaved`. `clearHistory`
is treated as destructive over the debug API and returns
`destructiveActionApproval`; direct registry mutation without the ShellX
operator path returns `browser_destructive_action_requires_operator`. The
visible Browser window clears local history only through a user-confirmed Tauri
command.

New child engines stay on `about:blank` while native credential controls, tab
behavior, permission denial, and the applicable strict request filter are
installed. ShellX navigates to the requested page only after those hooks
succeed; any later navigation/show/hide failure closes the partial webview and
waits for its native label to be released before returning an error.

`fillFromVaultGrant` requires `grantId`, `secretRef`, and either `refId` or
`selector`. ShellX authorizes the grant for `Fill`, reads the Vault value
inside the app process, performs an internal `fillRef`, records a redacted
`browserVaultCredentialFilled` receipt, and never returns the secret value.
`fillProfileCardGrant` requires `grantId`, `resourceRef`, profile field `key`,
and either `refId` or `selector`. ShellX authorizes `ProfileFill`, extracts
only that one field from the encrypted profile-card resource, performs an
internal `fillRef`, and records `browserProfileCardFilled`.
`readEmailCodeGrant` authorizes `EmailCodeRead` on a compatibility
`emailInbox` resource and returns only the short code plus redacted receipt
metadata. The Vault UI does not expose a separate email-resource editor; email
account passwords should be stored as normal `secret` entries. `useAgentWalletGrant`
validates `AgentWalletUse` on a `stripeAgentWallet` resource, but the current release returns
`501 browser_agent_wallet_checkout_unavailable` because grant approval alone is
not proof of a provider payment operation. ShellX does not store generic user
payment cards or claim that an unavailable checkout was prepared.

Browser tabs are first-class control objects. A locked tab rejects observation,
navigation, and DOM mutation unless the request includes the matching
`lockLeaseId`, `ownerAgentId`, and `ownerRunId`. Denied actions return
`status:"tabLocked"` with a `browserTabLockDenied` receipt and do not touch the
page. The Debug API does not expose operator force-unlock; callers must own the
lease or wait for expiration.

Browser task snapshots record immutable `ownerActorId` and `ownerSurface`
metadata assigned by the authenticated creation surface. Task mutation checks
that principal before applying agent controls; callers cannot replace it with a
caller-supplied actor label. `POST /browser/task/control` can pause, resume, or
abort an agent task, and its receipts use the fixed `shellxDebugApiAgent` actor.
Trusted operator authority can enter `userTakeover`, resume a task from that
state, or finish it while the user owns control. It is available through the
Tauri commands and through an intentionally headerless, bearer-authenticated
Debug API request; those receipts use `shellxBrowserOperator`. Host MCP calls
remain exact-session Agent authority. Forbidden Agent attempts return HTTP 403
with `code:"browser_task_operator_control_required"`. While a task is `paused`,
`blocked`, `completed`, `aborted`, or `userTakeover`, `/browser/action`
returns a blocked response such as `status:"taskPaused"` plus a
`browserTaskActionBlocked` receipt before it reaches the native WebView path.
This keeps human takeover and stop/pause decisions authoritative even for
engine-backed actions.

Browser state transport is revision-driven. `browser-event` frames carry the
receipt revision; the Browser renderer refreshes core state and only the
currently visible History, Actions, Errors, Requests, bookmark, or transfer
slices. While the event stream is disconnected it polls only
`/browser/summary` every 15 seconds and fetches core/detail data when the state
revision changes. MCP `browser_state` also returns `/browser/summary` by
default; every returned slice is caller-scoped, and callers must name heavy
`include` slices such as `history`, `receipts`, `network`, `logs`, or
`observations`.
For a state check that must not alter the coworking surface, MCP `browser_check`
uses `/browser/check`. For a public/incognito JavaScript-rendered text, title, or
selector check that needs no interaction, MCP `browser_rendered_check` uses the
bounded hidden renderer at `/browser/rendered-check`. Plain HTTP checks should
use `net_fetch`; authenticated, interactive, approval-bearing, and human-cowork
work continues through the visible ShellX Browser.

Task ownership is tab-backed. Closing one of several task-owned tabs leaves the
task unchanged; closing the final owned tab aborts a nonterminal task with
`statusReason:"lastTabClosed"`, cancels its pending session grants and dialogs,
and emits `browserTaskAborted`. Completing, blocking, or aborting a task keeps
its tabs available for inspection but clears terminal task context from
`activeTaskId`. Tabless terminal history is limited to the newest 100 entries
and seven days, while active/nonterminal tasks are never pruned. State reads
repair runtime orphans to `aborted` with `statusReason:"orphanedTask"` and emit
lifecycle/pruning receipts.

Agent-created tasks always carry an exact `ownerSessionId`. Agent task creation
without a valid session is refused, and an owner-session-less legacy Agent
snapshot cannot be claimed by any Agent caller. Operator-created runtime tasks
carry the fixed operator actor/surface identity without an Agent session.
Agent actions and controls fail closed when the MCP caller identity does not
match; trusted operator actions remain able to pause, resume, take over, abort,
or finish the task. Browser task state is runtime-memory only, so no durable task
migration path depends on the retired ownerless Agent compatibility behavior.

Prompt-injection blocks are ordinary Browser receipts and therefore remain
visible in the operator Actions/Evidence surfaces. Browser chrome actions also
surface the bounded block message instead of treating an HTTP 200 policy result
as navigation/action success. Direct actions attempt one bounded fresh observe;
if classification remains unavailable, re-observe the current page and review
the receipt before any explicit one-request operator override.

Browser Chat uses the same session binding. A direct user send or **Explain
page** starts a task on the currently selected main-window ShellX agent tab, or
continues the running task on its original `ownerSessionId`. The main window
then uses its normal Grok/provider and Local/WSL/SSH send path. Browser Chat
folds the attached tab's real assistant, tool, and lifecycle events instead of
manufacturing replies from Browser task or engine status. Changing the active
main tab does not silently move an existing Browser task; the user must return
to its attached session or start a separate task. Pause, takeover, abort, and
Request Center remain operator-authoritative.

Browser task navigation accepts public `http`/`https` and `about:` targets.
Private/local hosts such as loopback, link-local, RFC1918, `.local`, metadata
targets, and DNS names that resolve to private/local addresses require an
explicit `expectedDomains` match on the task before `startUrl` or a later
`navigate` action is accepted. Manual taskless navigation inside the personal
profile remains available for normal local browsing.

Browser privacy modes are user/profile settings. `off` disables ShellX
ad/tracker handling for the profile or site and resets stale Shields counters.
`balanced` is the default and applies local presentation suppression, guards
common ad/tracker `fetch`, beacon, XHR, popup, and dynamically inserted script
requests, and records local privacy stats on the tab Shields state. `strict`
adds the Windows WebView2 native request filter so matching ad/tracker
subresources are answered before they load, while non-Windows builds currently
fall back to the local balanced guard path until an equivalent native hook is
available. Older clients may still send the deprecated
`visualCleanCompatibility` value; the Browser UI treats that legacy state as
Balanced. Browser Shields can disable or tighten ad/tracker handling per site,
and privacy/Shields changes are reapplied to the mounted WebView at runtime.

Downloads and uploads are explicit intent records. `/browser/downloads/request`
and `/browser/uploads/request` create receipt-backed transfer entries; manual
Browser page-save requests can include `destinationDir` from the shared Browser
default download folder, which is editable in the Downloads sidecar and global
Settings. Host MCP `browser_save_page` uses explicit `destinationDir`, then
that Browser default download folder, then OS Downloads. Raw `downloadFile` and
`uploadFile` actions remain gated by `downloadApproval` and `fileGrant` until a
user or task grant exists.
`/browser/downloads/complete`
and `/browser/uploads/complete` mark an existing transfer completed only when an
`approvalId` references a host-granted transfer approval and `retentionReason`
is supplied. Approval tokens are minted only by the operator/UI Tauri
`shellx_browser_grant_transfer` command. Completion stores final path,
MIME/content kind, bytes, SHA-256, safe source URL, destination, and retention
reason, then emits `browserDownloadCompleted` or `browserUploadCompleted`.
The Browser keeps an upload's local source path only in private host state while
the transfer is pending. Agent/Debug API responses, receipt evidence, and upload
list rows expose the sanitized basename and clear both `filePath` and
`finalPath`; they are not a local-filesystem existence oracle.

Browser observations are compact and task-facing. Alongside bounded
`text`/`markdown`, `snapshotId`, and selector-backed `refs`, `observe` returns:

- `domSummary`: counts for links, buttons, inputs, forms, tables, headings,
  observed text bytes, traversed same-origin frames and open shadow roots,
  skipped cross-origin frames, plus `traversalTruncated` when a traversal bound
  was reached;
- `formFields`: bounded form/control metadata with label, selector, field kind,
  required/disabled state, autocomplete, form action, and redacted password
  values;
- `formFieldGroups`: grouped field intent metadata for common login, signup,
  profile, address, verification, payment, search, and API-key/token forms, so
  agents can plan fills without guessing from raw DOM text;
- `accessibilityTree`: a bounded accessibility-style control summary, including
  synthetic `page`, `address`, and `report` nodes so external agents can target
  stable Browser actions consistently;
- `delta`: when a prior observation exists, its `fromSnapshotId`, change flags,
  authoritative added/removed/updated ref counts, and a shared bounded list of
  up to 40 `addedRefIds`, `removedRefIds`, and `updatedRefIds`. Use
  `changed:false` to avoid re-planning an unchanged page; `truncated:true` means
  the counts remain authoritative while some ref ids were omitted.

`snapshotId` covers bounded redacted page text/markdown, structural counts,
ref identities/state, and redacted form-field state. Text-only or field-state
changes therefore receive a new snapshot even when the DOM shape is unchanged.
Observation labels, form intent, actionability hints, and the server-side
keyword risk classifier are planning inputs derived partly from hostile page
content. They can raise the approval floor but can never lower a hard Browser,
Vault, origin, transfer, or operator gate.

Selector-backed refs also include agent reliability metadata: `name`, `testId`,
opaque `fingerprint`, bounded `domPath`, `frameUrl`, `shadowPath`, select
`optionValues`,
`locatorSuggestions` for role/name, label, placeholder, text, test id, CSS, and
XPath where available, `bounds`, `visible`, `enabled`, `editable`, `frameId`,
and `strictMatchCount`. Engine-backed actions return `actionability` evidence
for attached, visible, stable, enabled/editable, in-viewport, receives-events,
strict-match, and observed-fingerprint checks. Ordinary failed checks return
`notActionable`; a changed ref identity returns `staleRef` without acting.
`stable` is measured from at least two geometry samples spanning 120 ms and no
finite running geometry animation, with `stabilityMs` and `stabilitySamples`
returned as evidence. DOM click, fill,
select, press, and secret-capture actions retry only transient stability
failures for a bounded two seconds; other failed checks remain authoritative.
Selector-based `waitFor` also requires a visible stable element, while
text-only waits do not pay the element-stability delay.
Observation and ref actions traverse same-origin frames and open shadow roots
within fixed root, node, frame-depth, and shadow-depth budgets. A nested ref's
selector remains local to its owning DOM root; agents should act through its
`refId`, which resolves through an internal locator that is never serialized in
API responses. Bounds are reported in the top-page viewport. ShellX counts but
does not inspect or control cross-origin frames; those remain an explicit
browser security boundary.
Covered click targets include `actionability.coveringElement` so an
agent can close or wait through overlays before retrying. `waitFor` accepts
`timeoutMs` to poll bounded page state before returning `notFound`. The
`findText` action scrolls the first visible text match into view
and returns bounded match metadata plus a `browserFindTextCompleted` receipt.
The `verify` action supports `key:"text"`, `"url"`, `"element"`,
`"table"`, and `"schema"` expectations and returns a `verification` object plus
`browserVerificationPassed` or `browserVerificationFailed` receipts.
Every `/browser/action` response may also include `stepSummary`, a compact
agent-loop summary with action/status, current URL, title, security level, page
status, DOM/control counts, snapshot id, target ref/selector, failed checks,
locator recovery candidates, bounded `nextActions`, and recovery hints. It is
metadata-only: it does not include raw page text, markdown, form values, typed
values, cookies, headers, local storage, screenshots, or secrets.

`captureScreenshot` captures the ShellX Browser window by default, saves a PNG under
`~/.shellx/browser-artifacts/shellx-browser-screenshots/`, and returns a `screenshot` artifact with
`path`, `bytes`, `sha256`, `width`, `height`, `source`, `fullPage`,
`pageWidth`, `pageHeight`, URL, and title metadata. Pass `fullPage:true` to
capture one page-content PNG for the whole document instead of the visible
Browser window. For full-page captures, `width`/`height` are image pixels and
`pageWidth`/`pageHeight` are CSS pixels; use that ratio when converting visual
points into `browser_click_at` / `browser_type_text` coordinates. Re-capture
after Browser viewport changes, and scroll off-screen targets into the viewport
before coordinate-clicking.
It emits `browserScreenshotCaptured` so visual evidence can be attached to the
task trace without sending raw pixels through the text observation channel.
The Browser Save page menu also includes an operator-clicked **Explain page**
action. It extracts a bounded Markdown/text excerpt when available, strips URL
query strings and fragments from the task text, and sends the task through the
Browser Chat session binding so the selected ShellX agent can explain the page
without dumping raw Browser state or secrets into user folders.
`POST /browser/trace/export` writes a bounded JSON trace bundle under
`~/.shellx/browser-artifacts/shellx-browser-traces/` and returns `traceId`, `path`, `bytes`,
`sha256`, source, and a `browserTraceBundleExported` receipt. The bundle keeps
task/tab/engine state, last-observation metadata, recent receipts, console logs,
transfer intents, privacy settings, and an explicit redaction policy. It does
not retain raw DOM, cookies, local-storage values, network bodies, raw secrets,
or full screenshots. It should be left in ShellX trace storage unless the user
explicitly asks for an exported copy.
`POST /browser/flight-recorder/export` writes the FR-1 attempt bundle. It writes
`sx.flightRecorder.v1` under
`~/.shellx/browser-artifacts/shellx-browser-flight-recorder/`, selects at most
320 ordered events and 160 ordered receipts, caps the artifact at 512 KiB,
removes HTTP(S) path/query/fragment values, sanitizes credential-shaped text, and excludes raw
cookies, authorization headers, storage values, network bodies, DOM snapshots,
and screenshots. Before the artifact is written, the final assembled bundle is
also passed through the host-side protected-value registry for its exact task
and tab; page-side taint markers are defense in depth, not authoritative
redaction evidence. Events now retain a browser-wide monotonic source sequence,
provider-neutral Browser operation class, and export-local order. The summary
reports selection truncation, explicit sanitizer-loss markers, and task-owned
retention loss separately, marks every affected artifact incomplete, and includes time to first evidence,
action, and network activity. Timing accounting stays explicitly partial with
unaccounted duration left unknown until non-overlapping action durations are
recorded. Task-local owner, tab, handoff, and grant lineage is retained without
exposing the owner-session ID; parent/child task lineage remains explicitly
unsupported rather than inferred. Routed agent calls must match the Browser task's authenticated
owner session; cross-task/tab pairs are refused. Bearer-authenticated direct CLI
calls use operator authority. The response includes selected/dropped counts,
task-owned retention gaps, sanitizer-loss count, completeness, path, exact bytes,
SHA-256, and a receipt.
`POST /browser/evaluations` writes the FR-2 `sx.evaluation.v1` report. It accepts
at most 200 declared attempt outcomes, opens only canonical files below private
Flight Recorder storage, checks exact bytes, SHA-256, schema, attempt/group/task
identity, and redaction receipts, never embeds attempt bodies, and caps the
report at 256 KiB. Missing/incomplete evidence and unsafe candidates fail
closed. Every attempt must come from a distinct Browser task, baseline and
candidate task sets must be disjoint, and the suite/group must match the source
artifact; one run therefore cannot be relabelled into both cohorts. Even a
re-hashed artifact cannot be evaluated as complete when its
recorder gap receipt says evidence was truncated or lost. `GET /browser/evidence?limit=20` returns bounded recorder/evaluation
receipt identities; routed callers see only tasks owned by their ShellX
session. These routes are available through the two-tool gateway and CLI. An
exact unsigned Windows test PE passed the complete route locally and on a
native Windows OpenSSH test target, and the bounded Evidence UI is accepted in
current source. Signed packaged and installed-package acceptance remain open.

Run `pnpm test:shellx-browser-flight-recorder-installed -- --out <receipt.json>`
against an exact built app to exercise a real local page through the installed
Debug API and tab-bound Host MCP. The gate asserts that only `browser_read` and
`browser_act` are advertised, writes exact baseline/candidate artifacts,
evaluates them through the routed gateway, checks caller-scoped evidence, runs
both CLI fallbacks, cleans only its owned Browser lifecycle, restores the test
tab to ShellX Full Auto, and emits an identity-only receipt without tokens or raw
Browser state. Set `SHELLX_EXPECT_BUILD_COMMIT` to make source identity a hard
gate and `SHELLX_TEST_HOST_LABEL` to label the host receipt. For cross-host
execution, `SHELLX_FLIGHT_RECORDER_FIXTURE_URL` may point only to an
unauthenticated `http://127.0.0.1:<port>` fixture already running on the target
host; other schemes, hosts, credentials, and missing explicit ports are
rejected.
`POST /browser/cdp/execute` is the gated CDP-like executor for native WebView
debugging. It requires Browser Developer Mode, full CDP access, and an
approved active host before running bounded methods such as
`Runtime.evaluate`, `Performance.getMetrics`, and `DOM.getDocument`; results
are redacted before they are returned or stored in receipts. Debug API callers
cannot enable Developer Mode, disable it, reset approved hosts, or approve
hosts; that authority belongs to the ShellX operator/UI Tauri path.
`POST /browser/har/export` and `POST /browser/performance/export` write hashed
artifacts under `~/.shellx/browser-artifacts/shellx-browser-har/` and
`~/.shellx/browser-artifacts/shellx-browser-performance/`. HAR exports contain safe request/response
metadata only: no headers, bodies, cookies, query strings, or fragments.
Performance exports sanitize resource URLs before writing timings.
`POST /browser/recipes/export` converts recent receipts into a redacted replay
recipe under `~/.shellx/browser-artifacts/shellx-browser-recipes/`; typed input
values become `valueRef` placeholders, and later selectorless wait/search
literals after redacted input are redacted, so replay must source values from
the user or Vault or use fresh selector-based observation.
Recipe artifacts use Action Recipe V2 fields: `schemaVersion`, workflow `goal`,
redacted `steps`, `variableInputs`, `assertions`, `decisionPoints`,
`sourceReceipts`, and `redactionPolicy`.
Decision points include route drift, input-source selection, and
`fresh-observation-after-redacted-text` when a prior wait/search cue was
redacted and replay must continue from live page evidence.
`POST /browser/recipes/replay` dry-runs by default. When called with
`dryRun:false`, ShellX converts replayable recipe steps such as navigation,
observe, click/click-ref, wait, scroll, select, press, verify, extract, and
non-redacted find-text into Browser actions and applies them through the same
WebView engine, locks, receipts, and approval gates as normal agent Browser
control. This makes saved workflows real fast tracks for repeated site tasks
while redacted input, live Vault capture/fill, unsupported actions, and failed
applies are returned as `skippedSteps` with stable reasons instead of being
silently replayed. Replay responses also include recipe `decisionPoints` so
dry-runs can explain route drift, input-source, and fresh-observation needs
without opening the artifact file. Text-only wait/search steps redacted from
prior secret-adjacent input return `redactedTextRequiresFreshObservation`, which
means the agent should observe the current page and continue with selectors or
mediated Vault/user bindings rather than asking for the raw text.

The shared Browser reliability fixture matrix locks these boundaries together:
fingerprint mismatches never auto-recover, missing refs may recover only to one
strict visible replacement, covered clicks may use the narrow force-click
retry, sensitive actions never auto-recover, and replay pauses at live
Vault/user bindings while isolating unsupported non-binding steps.

Agents can save repeatable fast-tracks by exporting a successful task recipe
and then
upserting a Browser bookmark with
`agentWorkflow` taxonomy (`siteKey`, `taskType`, `target`, `surface`,
`secretKinds`, `recipePath`, and health/drift/contract metadata), so later runs
can discover the workflow before falling back to live navigation.

### Browser Agent Control Timing Checklist

Use `pnpm test:shellx-browser-batch-timing` as the live
`browser_run_steps timing` smoke when changing Browser agent-control plumbing.
The script expects a running installed ShellX app, reads the Debug API and MCP
HTTP discovery files from `~/.shellx`, switches a dedicated test tab into
`bypassPermissions`, then compares sequential Host MCP Browser calls against one
`browser_run_steps` call over the same local workflow fixture. The timing route
includes `navigate -> waitFor` so Host MCP navigation settle behavior is checked
against the installed app, not just by source-level tests. The same smoke also
exercises strict locator recovery for a stale `browser_click_ref` through the
real MCP endpoint. Treat the median numbers as evidence, not as a hard pass/fail
speed threshold: the gate proves that both paths complete through the real
tab-bound Host MCP write-class surface, while the timing table shows whether a
control-layer change improved or regressed round-trip cost.

When a batched step is automatically recovered by Host MCP, the compact
`browser_run_steps.steps[*]` row carries structured `mcpRecovery` evidence in
addition to the text summary, so evaluators do not need to parse status text.

`/browser/robots/*` manages recipe/work-queue jobs with auditable scheduled,
running, incomplete, failed, cancelled, and completed receipts. A run never
marks itself complete merely because a recipe path exists: it executes the
recipe planner or live replay first and copies the step totals into the terminal
receipt. `runAtMs` is currently durable due-time metadata; an explicit
`POST /browser/robots/run` starts execution until a background due-job runner is
attached. Robot job records are single-execution: terminal jobs cannot be run
again or relabeled cancelled; schedule a new job to create a separate audit
trail.
`GET /browser/storage-state` and `POST /browser/storage-state/export` expose
safe manifests only: profile id, storage root, cookie/local-storage policy,
retention policy, session grant status, and artifact hash when exported. They
never return cookie values, local-storage values, session-storage values,
headers, or network bodies. Task Disposable manifests report
`taskScopedEphemeral: true` and omit a reusable `storageRoot`; ShellX allocates
one marker-owned storage lease per task and retires it after the task or tab
ends. `POST /browser/session-grants/request` records an agent request for
profile session reuse. Session grant decisions are
operator-owned: Debug API resolve calls return
`browser_session_grant_resolution_requires_operator`, while the
`shellx_browser_resolve_session_grant` Tauri command applies the operator/UI
decision. `POST /browser/session-grants/apply` currently fails closed with
`browser_session_grant_application_unavailable`: approval alone does not make
session state available, set `appliedAtMs`, or emit an applied receipt. A later
Vault/session bridge must copy state into the exact approved profile and prove
that effect before this route can report success.
`GET /browser/dialogs` and `POST /browser/dialogs` keep dialog handling explicit
and auditable. Debug API resolve calls allow an agent to accept or dismiss only
its own pending `beforeunload` dialog on an agent-owned non-personal task tab,
so stuck dirty-page navigation can continue without exposing form values.
Other dialog decisions and prompt values are operator-owned and return
`browser_prompt_resolution_requires_operator`, while
`shellx_browser_resolve_dialog` accepts the operator/UI decision and includes
only a prompt-value presence flag in the dialog record. `GET /browser/permissions` and
`POST /browser/permissions` record notification/geolocation/camera/microphone/
clipboard-style page permission events with safe origin/path only; decisions are
resolved only by the operator/UI `shellx_browser_resolve_permission` command.
On Windows, native WebView permission requests and limited page-side permission
signals are recorded automatically and denied at the engine until ShellX
applies an explicit operator decision. `BrowserState.nativeSecurity` reports
the exact native gates available on the current platform. macOS and Linux show
an in-app degraded-protection notice because their native permission,
password-autosave, and Strict request-filter hooks are not yet equivalent;
permission and credential flows must remain operator-led there.
`GET /browser/popups` and `POST /browser/popups` record
popup/new-window requests with query/fragment redacted from visible URLs; they
do not expose a reusable hash of the hidden full target URL. The native
cross-platform WebView builder denies the unmanaged popup itself and records it
as approval-required; a target opens only through ShellX's normal governed tab
flow.
`GET /browser/network` returns bounded metadata from navigation/load/download/
popup events: method, safe URL origin/path, resource type, load status, blocked
flag, privacy decision, and explicit redaction flags for headers and bodies.

Every state-changing route stores a `BrowserReceipt`; browser debug handlers
also emit `browser-event` frames to the DebugHub. `BrowserVaultDepositResponse`
keeps write-only deposit behavior: the secret value is never echoed. It includes
a minimal `serverReceipt` object for the Vault/quarantine side
(`id`, `payloadHash`, `createdMs`, `fromToken`) while richer task/label/origin
context stays in the ShellX trace receipt.

Browser console logs are the agent-readable equivalent of the browser DevTools
console. Engine/WebView hooks, the Browser UI, or external debug drivers can
record page errors through `POST /browser/logs`, then read them through
`GET /browser/logs` or `/browser/state.consoleLogs`. Error-level logs produce
`browserConsoleError` receipts. Log messages are bounded and credential-shaped
lines are redacted before storage.

Sensitive action gates are deterministic. Credential/session use, payment,
publish/final submit, destructive deletes, security changes, raw secret reveal,
long-lived access, software install, and executing downloaded code all return
an approval requirement unless a future scoped grant satisfies the action.

---

## Session Asset Surface

`GET /state/session_assets?tabId=<tab>&limit=200` returns the generated
image/video assets visible to the reusable-assets board. It is read-only,
filters to live tabs, preserves provider-visible paths, and includes source
tab/session/cwd/transport metadata.

Response shape:

```ts
type SessionAsset = {
  assetId: string;
  kind: "image" | "video";
  path: string;
  title: string;
  toolTitle: string;
  status: string;
  sourceTabId: string;
  sourceSessionId?: string | null;
  sourceCwd?: string | null;
  sourceTransport?: "local" | "wsl" | "ssh" | string | null;
};

{
  count: number;
  assets: SessionAsset[];
  images: SessionAsset[];
  videos: SessionAsset[];
}
```

---

## Model Instruction Card Surface

`GET /state/model_instruction_cards` returns bundled instruction and
capability cards for user-directed model/tool orchestration. The cards tell
agents and UI code what a named provider or ShellX host tool can do, which
preflight checks are required, and how to invoke the selected surface.
Connected Grok, Codex CLI, and Claude Code sessions can read the same bundled
registry through the read-only host MCP tool `model_instruction_cards`. Provider
tabs can also use the host MCP tool `send_prompt_to_session` for an explicit,
user-approved handoff into Grok/ACP. When the caller omits `targetTabId` from a
provider tab, ShellX uses that same visible tab and connects its Grok child if
needed before queueing the prompt. Provider tabs can also use
`send_prompt_to_provider` for an explicit, user-approved handoff into Codex CLI,
Claude Code, or Antigravity CLI on the same visible tab/environment. ShellX
still does not pick fallback providers.

Media cards include direct recipes for GPT Image via Codex, Grok Imagine image,
Grok Imagine video, and Antigravity image generation. The Antigravity image
card permits a cross-provider route through `send_prompt_to_provider` with
`providerId: "antigravity-cli"` only from a different ShellX-host-enabled
provider/session. An already-running Antigravity session calls native
`generate_image` directly and never hands off to itself. Cross-provider
handoffs keep the same visible tab by default, use the long media timeout, and
set `includeShellxTooling: false` to select the target provider session's
existing off/no-ShellX-tooling mode unless the task independently needs ShellX
tooling. They require an operator-visible output name and an artifact path or
receipt. Aspect ratio or source-image paths are passed only when the user
supplied them. In a ShellX-host-enabled source session, agents should invoke a
named ShellX handoff tool immediately after the user names a supported provider,
rather than running raw provider CLIs or searching provider logs first. ShellX
clamps named media handoff timeouts below `900000` ms so short agent-supplied
watchdogs do not kill image or video generation.

The separate Antigravity video card is deliberately `provider-unavailable`: the
current native Antigravity CLI has no video-generation tool. Video attachments
or analysis and ShellX Browser WebM recording are different capabilities, not
Antigravity video generation. That card has no command hint, and agents must
not launch Antigravity solely for the unavailable request. They must report the
boundary and ask before using Grok Imagine or any future video provider.

ShellX does not silently route to a different provider based on these cards.
Every bundled card currently uses `routeMode: "explicitOnly"` and
`shellxMayAutoRoute: false`. If the user asks for "Grok Imagine video", an
agent should check the Grok card and Grok health, then either use the named
surface or report the failed preflight. It must ask before falling back to
another provider.

Cards also expose a `toolExposure` policy. The default is `nativeFirst`: a
provider should use its own terminal, file, patch, MCP, and streaming tools for
normal work. `hostBridge` is reserved for explicit ShellX handoff, preview,
asset, and receipt tools. `hostFull` is a future high-trust diagnostic mode,
and `off` hides ShellX host tools beyond minimal context.

Response shape:

```ts
{
  version: string;
  lastReviewed: string;
  policy: {
    shellxMayAutoRoute: false;
    defaultRouteMode: "explicitOnly";
    defaultToolExposureMode: "nativeFirst" | string;
    toolExposureModes: Array<{
      id: "nativeFirst" | "hostBridge" | "hostFull" | "off" | string;
      label: string;
      description: string;
      agentRule: string;
    }>;
    fallbackRule: string;
    operatorRule: string;
  };
  cards: Array<{
    id: string;
    displayName: string;
    providerId: string;
    category: "coding-agent" | "media-generation" | "shellx-host-tool" | string;
    status: string;
    routeMode: "explicitOnly" | string;
    shellxMayAutoRoute: boolean;
    intentExamples: string[];
    preflightChecks: Array<{ id: string; label: string; required: boolean }>;
    capabilities: Array<{ id: string; label: string; level: string; notes: string }>;
    toolExposure: {
      defaultMode: "nativeFirst" | "hostBridge" | "hostFull" | "off" | string;
      nativeToolRule: string;
      shellxToolRule: string;
      allowedShellxTools: string[];
    };
    invocation: {
      surface: string;
      debugApiPath?: string;
      commandHint?: string;
      requiresUserVisibleSelection: boolean;
    };
    agentInstructions: string[];
    receiptKinds: string[];
    fallbackRule: string;
    provenance: { source: string; refreshHint: string };
  }>;
}
```

The first bundled cards cover Grok Imagine video/image, Codex CLI, Claude
Code, Antigravity CLI, GPT Image via Codex, and ShellX Preview Doctor.

---

## Connection Provider Capability Snapshot

`POST /connections/provider-scan` accepts `{ preset: ConnectionPreset }` and
returns one fresh, exact-target inventory for all four supported CLIs. The same
contract is used by the Tauri `connection_provider_scan` command, Connections,
and the right-rail Agent CLIs card.

```ts
interface ConnectionProviderCapabilitySnapshot {
  schemaVersion: "shellx.provider-capability-snapshot.v2";
  generatedAtMs: number;
  freshUntilMs: number; // generatedAtMs + 60 seconds
  target: {
    key: string;
    transport: "local" | "wsl" | "ssh";
    runtime: "posix" | "windows" | "windows_wsl";
    label: string;
    wslDistro?: string;
    sshHost?: string;
    sshPort?: number;
  };
  providers: Array<{
    providerId: "grok" | "codex-cli" | "claude-code" | "antigravity-cli";
    canRun: boolean;
    status: "ready" | "missing" | "versionFailed" | "identityFailed" |
      "targetUnavailable" | "authNeeded" | "canaryFailed";
    binary?: string;
    version?: string;
    binarySha256?: string;
    binaryBytes?: number;
    targetKey: string;
    detail?: string;
    checkedAtMs: number;
  }>;
}
```

Target keys separate local, WSL, SSH POSIX, native Windows OpenSSH, and
Windows OpenSSH-to-WSL environments. For example,
`ssh:windows:host.example:22` and
`ssh:windows_wsl:host.example:22:wsl=ubuntu-24.04` are different targets.
A `ready` row is live evidence from that exact target: ShellX resolves the
binary, runs its bounded version probe, and recomputes the executable SHA-256
and byte size before and after that probe. Both identities must match. A
remembered prior launch or an executable replaced during probing cannot satisfy
this snapshot.
Keys never contain the SSH Vault reference or resolved identity-file path.
`ready` requires both a resolved binary and a successful bounded version
probe. `versionFailed` means the binary was found but its version probe failed;
the setup UI therefore does not incorrectly recommend reinstalling it.

### First-class Tasks and provider catalogue

The authenticated Task routes are a bounded 0.3.6 control-plane surface. They
manage durable definitions, project current state and unresolved attention,
queue one exact immutable revision, cancel one exact active attempt, and append
explicit attention acknowledgements. A queued response proves durable
acceptance only; the app-owned foreground runtime still performs every provider
transition behind its occurrence, lease, and receipt gates. A ShellX-launched
agent can use the write-class `task_manage` Host tool only after explicit
current-conversation intent such as “set this up and run it.” ShellX derives the
caller tab, environment, working folder, permissions and fresh worker catalogue;
ordinary discussion does not authorize persistence or execution.
The desktop Task Manager additionally accepts a path-free operator handoff from
Browser Teach after approval and a zero-skip dry run. The resulting draft shows
the reviewed workflow digest and each required Vault key, lets the user choose
only active all-agent mediated grants, starts paused with an empty provider
route, and still requires an explicit Save.

| Method | Path | Request / response contract |
| --- | --- | --- |
| GET | `/tasks` | Returns `{ tasks: TaskDefinitionRecord[] }`, ordered by newest definition update then task identity. |
| GET | `/tasks/states` | Returns `{ states: TaskStateProjection[] }`, including bounded run history, current saved versus fresh environment evidence, exact active-attempt identity when cancellable, the exact private ShellX Task conversation identity when archived, path-free Browser result-evidence identities when recorded, and unresolved-attention summaries. |
| GET | `/tasks/:task_id` | Returns `{ task: TaskDefinitionRecord }`. Task identifiers are bounded to 256 non-control characters. |
| GET | `/tasks/:task_id/state` | Returns `{ state: TaskStateProjection }` for the current immutable revision. |
| GET | `/tasks/:task_id/attention?limit=1..64` | Returns `{ attention: TaskAttentionItem[] }`; omitted `limit` is 24. Items use finite reason/source values and carry the exact acknowledgement precondition. |
| POST | `/tasks` | Accepts `{ draft: TaskDraft, paused?: boolean }` and returns `201 { task: TaskDefinitionRecord }`. The durable draft validation applies every per-field bound before writing. |
| POST | `/tasks/agent` | Internal authenticated Host bridge for `task_manage`. Requires an exact ShellX caller plus `userApproved: true`; derives execution authority from that caller, accepts a complete instruction/schedule and optional ordered ready workers, creates the durable Task, and optionally queues Run now. `createdRunNotQueued` truthfully preserves a successfully saved Task when immediate queueing fails. |
| Tauri | `tasks_persist_attachments` | Operator/UI-only `{ request: { connectionId, canonicalCwd, sources } }`. Reads 1–16 explicitly selected regular files inside the host user's home boundary or exact selected Local/WSL working folder, copies them to that exact Local/WSL/SSH target, verifies each SHA-256 after writing, and returns only `{ targetKey, attachments: [{ attachmentId, digest }], receipts }`. Original paths and bytes are absent from the response and Task store. There is no Debug API or Host MCP equivalent. |
| Tauri | `tasks_reclaim_attachments` | Operator/UI-only `{ request: { attachmentIds } }`. Reclaims only imports absent from every immutable saved Task revision. ShellX first records `reclaimPending`, then deletes only an exact target/cwd/digest match and seals `reclaimed`; unreachable targets, changed bytes, links, or reparse points remain pending and retryable. The path-free response partitions every requested ID into `reclaimedAttachmentIds` or `pendingAttachmentIds`. There is no Debug API or Host MCP equivalent. |
| Tauri | `tasks_maintain_attachments` | Operator/UI-only startup maintenance with no request body. Serially retries up to 16 durable `reclaimPending` records and imports that remained unreferenced for at least 24 hours after a renderer interruption. It uses the same exact-copy refusal rules and returns only selected/reclaimed/pending IDs. There is no Debug API or Host MCP equivalent. |
| POST | `/tasks/provider-catalog` | Accepts a direct `ConnectionPreset` or `{ preset: ConnectionPreset }` and returns the exact-target, sanitized provider catalogue described below. |
| POST | `/tasks/:task_id/revise` | Accepts `{ precondition: { expectedRevisionId, expectedRevisionHash }, draft: TaskDraft }`; returns the next immutable revision or `409 task_revision_conflict`. The path identity is authoritative. |
| POST | `/tasks/:task_id/pause`, `/tasks/:task_id/resume` | Returns `{ definition: TaskDefinition }`; each transition is receipt-backed. |
| POST | `/tasks/:task_id/run` | Accepts `{ revisionId, revisionHash }`; atomically persists one pending manual occurrence for that exact current revision and returns `202 { occurrenceId, disposition: "queued" }`. Provider dispatch is asynchronous and remains receipt-gated. |
| POST | `/tasks/runs/:occurrence_id/cancel` | Accepts `{ attemptId }` and returns `202` only while that exact occurrence/attempt is active; a stale identity returns `409 task_attempt_not_active`. The runtime persists terminal cancellation evidence before aborting the provider. |
| POST | `/tasks/:task_id/attention/:attention_id/resolve` | Accepts `{ expectedOpenedAtMs }`; appends an explicit hash-linked acknowledgement or returns `409 task_attention_conflict` when the item changed. |
| POST | `/tasks/:task_id/attention/overflow/resolve` | Accepts `{ expectedAttentionId, expectedOmittedCount, expectedUpdatedAtMs }` for the bounded saturation aggregate and refuses stale counts. |
| DELETE | `/tasks/:task_id` | Soft-deletes the definition, emits its durable receipt, and returns `204`. |
| GET | `/tasks/:task_id/receipts?limit=1..256` | Returns `{ receipts: TaskReceipt[] }`; omitted `limit` is 64. The journal is a bounded, verifiable tail and never contains provider output, attachment paths, Browser URLs, option values, or credential material. Every terminal automatic run appends output-free `occurrenceTraceEvidence`; a workflow-backed run may also append `occurrenceResultEvidence`. Both bind the exact terminal Task receipt and provider attempt. |

All Task mutation request bodies have a 4 MiB transport cap in addition to the
Task contract's much tighter field and collection limits. Error bodies use a
stable public code and redacted message; unknown storage failures never return
filesystem, corruption, or serialization detail.

`TaskDraft.executionPolicy` must describe one runnable ShellX policy at save
time. Supported permission/autonomy pairs are `default` with `plan`,
`acceptEdits`, or `default`, and `bypassPermissions` with
`bypassPermissions`. `toolExposureIds` contains exactly one of `nativeFirst`,
`hostBridge`, `hostFull`, or `off`. Create and revise reject missing,
contradictory, multiple, or unknown values before writing a revision.

When an immutable Task revision binds a reviewed Browser workflow, the managed
runtime uses the exact deterministic provider-tab identity to find only Browser
tasks owned by that run. After the occurrence is terminal, ShellX exports a
bounded Flight Recorder bundle for each owned Browser task and appends one
`shellx.task-result-evidence.v1` receipt. Its finite state is `complete`,
`incomplete`, or `noBrowserActivity`; identities contain only the Browser task,
Flight Recorder attempt or evaluation report ID, artifact SHA-256, Browser
receipt ID, completeness, and time. Evaluation identities are attached only
when that exact owned Browser task already produced an evaluation report; the
Task collector does not invent a comparison. Private artifact paths, page
content, URLs, provider output, prompts, and credentials stay outside the Task
store and renderer projection.

Every claimed Task attempt also receives one deterministic hidden runtime tab
and one normal private ShellX session archive under that same identity. ShellX
writes the reviewed instruction before provider dispatch, then records the
ordinary Grok, Codex, Claude, or Antigravity event stream on a bounded dedicated
writer. After the terminal receipt, `shellx.task-trace-evidence.v1` records only
the full-file SHA-256, bounded byte/record/provider-event/drop counts, archive
format and terminal-marker state, recovery state, and—only for a reviewable
archive—the exact private session identity. It never stores output, prompts,
tool arguments, transcript paths, or credentials. `Open run` is enabled only by
that Trace receipt and loads the archive through the same past-conversation path
as an operator chat. A restart recovery may retain a reviewable archive while
truthfully marking completeness `incomplete`, because prior in-memory queue
drop state cannot be reconstructed. The renderer does not create a second
archive for hidden Task tabs.

`POST /tasks/provider-catalog` accepts either a direct `ConnectionPreset` or
`{ preset: ConnectionPreset }`, exactly like `/connections/provider-scan`, and
returns one fresh `shellx.task-provider-catalog.v1` projection for that exact
input target. It never performs a saved-connection fallback. The catalogue is
an availability view only: it does not choose a provider, model, authentication
context, or fallback. It includes the four supported provider identities,
typed availability status, safe status-derived detail, capability guidance, an
empty `models` list, `providerDefault` model mode, and an optional normalized
semantic version such as `0.136.0`. A version is present only when ShellX can
reduce provider output to exactly one isolated ASCII semantic-version token;
raw version lines are never returned. The projection deliberately omits binary
paths, binary hashes and sizes, raw probe diagnostics, and authentication
material.

An immutable Task revision may reference one saved Browser workflow by
bookmark identity plus SHA-256 digest and named Vault requirements by key/grant
identity. Before provider dispatch, the app-owned runtime rechecks the saved
workflow's fresh health/drift state and exact recipe-export receipt, then checks
Vault key/grant metadata without reading the secret value. Providers without
the required ShellX host tools are rejected before effect. Recipe paths, raw
Vault values, and provider output never enter the Task prompt or receipt;
durable attachments are accepted only after the operator/UI Tauri path has
copied them into the exact target's private content-addressed Task folder and
recorded a hash-linked receipt. New Task saves reject unknown, target-mismatched,
digest-mismatched, duplicate, or path-substituted references. Before every
dispatch, ShellX re-reads the owned copy and gives the provider only its bounded
relative path, durable ID, and digest. The Debug API can save or revise only
already-recorded references; it cannot import files or mint attachment IDs.
Closing an unsaved Task draft, or successfully saving after removing an import,
invokes the two-phase reclamation path. Any immutable saved revision is a hard
reclamation root, including historical revisions. Installed startup
maintenance retries pending work and safely discovers 24-hour-old imports left
before a draft could close.

---

## Agent CLI Setup Surface

The setup assistant exposes the same Local/WSL/SSH agent CLI setup flow used
by Connections and the right-rail Agent CLIs card. It is explicit-action only.
For vendor bootstraps, `prepare` downloads but does not execute a script: it stages
the file in an owned target-local temp directory so the operator can review its
source, byte count, and SHA-256 before confirmation.

| Method | Path | Body/query |
| --- | --- | --- |
| GET | `/state/agent_cli_setup` | `?connectionId=<conn-id>` optional; omitted means current local |
| POST | `/agent_cli_setup/install/prepare` | `{ connectionId?, preset?, providerId, methodId? }` |
| POST | `/agent_cli_setup/install/confirm` | `{ confirmationId }` |
| POST | `/agent_cli_setup/install/cancel` | `{ confirmationId }` |
| POST | `/agent_cli_setup/recheck` | `{ connectionId?, preset? }` |

`providerId` is one of `grok`, `claude-code`, `codex-cli`, or
`antigravity-cli`. `preset` is a full `ConnectionPreset` body and is useful for
debug scripts that are testing an unsaved WSL or SSH target.

`prepare` returns the exact command, shell, provider, target, official source,
and `requiresConfirmation: true`. Vendor methods additionally return
`installerSourceUrl`, `stagedPath`, `artifactSha256`, `artifactBytes`, detected
version status, and the verification policy. Source URLs must be HTTPS, use an
approved vendor host, and must not redirect. `confirm` accepts only the id,
recomputes the staged file digest, invokes a fixed interpreter only when it still
matches, and removes the owned temp directory on success or failure. `cancel`
removes an unexecuted staged artifact. Callers cannot pass a command, path, URL,
or digest during confirmation.

---

## Provider Adapter CLI Surface

These endpoints are the first ShellX-native integration layer for
non-Grok coding-agent CLIs. They do not replace the current Grok ACP chat
session. They let an authenticated driver discover and run Codex CLI,
Claude Code, and Antigravity CLI from ShellX's debug API, then receive a
normalized parse result.

| Method | Path | Body/query |
| --- | --- | --- |
| GET | `/provider-adapters/state` | `?transport=local\|wsl\|ssh&wslDistro=<distro>&sshHost=<user@host>&sshPort=<port>&sshKeyVaultRef=<vault-key>&sshRemoteRuntime=posix\|windows\|windows_wsl&sshWslDistro=<distro>` optional |
| POST | `/provider-adapters/run` | `{ providerId, cwd, prompt, includeMcpProbe?, includeShellxTooling?, shellxToolExposure?, mcpPath?, timeoutMs?, persistSession?, resume?, resumeLast?, providerConversationId?, permissionMode?, transport?, wslDistro?, sshHost?, sshPort?, sshKeyVaultRef?, sshRemoteRuntime?, sshWslDistro?, recordEvents? }` |
| GET | `/provider-sessions/state` | `?tabId=<tab>&transport=local\|wsl\|ssh&wslDistro=<distro>&sshHost=<user@host>&sshPort=<port>&sshKeyVaultRef=<vault-key>&sshRemoteRuntime=posix\|windows\|windows_wsl&sshWslDistro=<distro>` optional |
| POST | `/provider-sessions/start` | `{ tabId?, providerId, cwd, prompt, includeMcpProbe?, includeShellxTooling?, shellxToolExposure?, mcpPath?, timeoutMs?, persistSession?, resume?, resumeLast?, providerConversationId?, permissionMode?, codexDriver?: "execJson"|"appServer", transport?, wslDistro?, sshHost?, sshPort?, sshKeyVaultRef?, sshRemoteRuntime?, sshWslDistro? }` |
| POST | `/provider-sessions/abort` | `{ tabId?, runId?, transport?, wslDistro?, sshHost?, sshPort?, sshKeyVaultRef? }` |

`providerId` is one of `codex-cli`, `claude-code`, or
`antigravity-cli`.

`GET /provider-adapters/state` is read-only and does not spawn provider
model runs. When provider sessions have run, each provider summary may
include `lastRunId`, `lastRunAtMs`, and `lastError`.

`POST /provider-sessions/abort` with `runId` aborts that exact run. With
only `tabId`, ShellX aborts every active provider child in that tab; with
`transport`/`wslDistro`/`sshHost`/`sshPort`/`sshKeyVaultRef`, it aborts
every active provider child matching that transport target.

Provider run commands:

| Provider | Command surface | Observable stream |
| --- | --- | --- |
| Codex CLI | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check <prompt>` | JSONL with assistant messages, file changes, command execution, MCP tool calls |
| Claude Code | `claude -p --output-format stream-json --include-partial-messages --include-hook-events --permission-mode bypassPermissions --verbose <prompt>` | stream-json with partial text deltas, tool-use blocks, hook events, final result |
| Antigravity CLI | `agy --dangerously-skip-permissions --add-dir <cwd> --add-dir <private-shellx-workspace> --agent <tab-agent> --print <prompt> --output-format stream-json` | NDJSON `init`, `step_update`, and `result` events with text deltas, tool/subagent metadata, conversation id, and usage; ShellX host MCP remains disabled |

Provider runs default to `transport: "local"`, which launches provider
binaries on the Windows/local host. For WSL provider CLIs, pass
`transport: "wsl"` and `wslDistro`; ShellX wraps the native provider command
as `wsl.exe -d <distro> --cd <cwd> -e bash -lc '<provider> ...'`. In this
mode `cwd` must be the POSIX WSL project path. For SSH provider CLIs, pass
`transport: "ssh"` and `sshHost` (`user@host`); ShellX launches `ssh -T` and
reverse forwards the ShellX host MCP HTTP port. `sshRemoteRuntime` defaults to
`posix`, which uses a POSIX cwd and shell. Use `windows` with a Windows absolute
cwd to discover and run Windows-installed provider CLIs through an encoded
PowerShell dispatcher; setup, prompt, environment values, and MCP token are
streamed over stdin rather than serialized into the SSH command. Use
`windows_wsl` plus `sshWslDistro` to enter a named WSL distro through a native
Windows OpenSSH server while keeping a POSIX path frame. `sshWslDistro` is
rejected for `posix` and native `windows` routes, so WSL cannot become an
implicit fallback. `sshPort` is optional.
`sshKeyVaultRef` is a non-secret vault key whose value is the local SSH identity-file path;
ShellX resolves it for SSH probes and provider launches and does not expose the
resolved key path in debug API state. Provider session resume ids are scoped by
provider, transport target, SSH runtime, Windows WSL distro, and SSH key vault
ref, so a local Claude session id is not reused for `wsl:Ubuntu-24.04`, native
Windows, Windows-plus-WSL, `ssh:deploy@203.0.113.10`, or another saved identity
on the same SSH endpoint.

Provider sessions default to `persistSession: true`. Ordinary interactive
external-provider tabs do not gain a second ShellX transcript store; ShellX
records only the provider-native conversation id it
can observe, keyed by tab, provider, and transport in
`~/.shellx/provider-sessions.json`.
Codex ids are read from JSONL `thread_id`/session fields, Claude ids from
stream-json `session_id`/session fields, and Antigravity ids from the
`conversation_id` carried by its structured events.

Resume policy: ShellX should use provider-native resume wherever the provider
has one. For Codex and Claude this means persisting the native conversation id
per ShellX tab/provider and calling the provider resume surface. For Grok ACP
tabs this means `session/load` with the prior `sessionId`. ShellX should not
build a parallel transcript-memory system for normal provider sessions. The
exceptions are ShellX-owned automatic Task attempts, whose reviewable private
session archive is the user-facing run record, and `/build`, where the build
scratchboard, receipts, and run gates are injected because they are ShellX
state, not provider memory.

Resume fields:

| Field | Behavior |
| --- | --- |
| `resume: true` | Resume the supplied `providerConversationId`, or the stored id for this tab/provider, or the provider's latest session if no id is known. |
| `resumeLast: true` | Ask the provider CLI to resume its latest native session. |
| `providerConversationId` | Explicit native conversation/session id for this run. ShellX records it as the requested resume source, but stored mappings update only after provider output confirms/accepts an id. |

If `permissionMode` is omitted, ShellX defaults to `bypassPermissions` so
provider sessions behave like the rest of ShellX's Full Auto agent surfaces.
This is an intentional high-trust mode: ShellX passes each provider its native
auto/bypass flags and provider-native permission prompts are not converted into
ShellX permission pills. Debug API clients may also send
`permissionMode: "auto"` as an alias for `bypassPermissions`.
`permissionMode` maps ShellX intent onto each provider's native flags:

| Mode | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| `bypassPermissions` / `auto` | `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |
| `acceptEdits` | `--sandbox workspace-write -a never` | `--permission-mode acceptEdits` | `--dangerously-skip-permissions` |
| `default` | `--sandbox workspace-write -a untrusted` | `--permission-mode default` | `--sandbox` |
| `readOnly` | `--sandbox read-only -a never` | `--permission-mode plan` | `--sandbox` |

Codex sessions also accept an experimental `codexDriver` selector. It defaults
to `execJson`, which preserves the released `codex exec --json` behavior.
`codexDriver: "appServer"` selects the bidirectional `codex app-server` JSONL
driver for explicit conformance work. That route keeps the prompt on stdin,
performs initialize → thread start/resume → turn start in order, normalizes
typed items and cumulative usage into the standard provider envelope, and
persists the returned native thread id. Authenticated ephemeral read-only
canaries are passing directly on Linux, through the `wsl.exe` distro wrapper,
and through POSIX SSH to an installed macOS Codex 0.144.6 target. The SSH driver
keeps `-n` for one-shot providers but leaves stdin attached for app-server.
The installed native Windows Codex 0.145.0 also passed a direct ephemeral
read-only app-server turn. A current-source Windows test PE then passed the
ShellX supervisor canary against that installed CLI in 8.63 seconds; this is
source/runtime evidence, not an installed desktop-app claim. Windows-to-WSL
still requires an installed-target canary.
For native Windows OpenSSH, ShellX encodes the PowerShell launch bootstrap in
the SSH command, loads and removes any private environment file before Codex
starts, and reserves stdin exclusively for app-server JSONL. The prompt remains
off argv and is sent only in `turn/start`. A native Windows OpenSSH target
passed a bounded two-message child-process JSONL framing canary; a remote
provider turn still requires the selected CLI to be installed and authenticated
on that target. `resumeLast` is also rejected for
this driver until thread discovery is implemented; pass an explicit
`providerConversationId` instead.

This selector is not used by the normal composer yet. If app-server asks for a
permission decision, ShellX emits both a `waitingForApproval` provider tool
event and the existing in-chat permission row. Allow, Allow always, and Deny
map to the provider's exact modern or legacy response vocabulary. Additional
permission requests grant only the requested network/filesystem subset;
read-only sessions return an empty grant, while bypass sessions approve for the
session. Unanswered interactive requests decline after 60 seconds, and pending
requests are denied during abort/teardown so the reader cannot hang. Reconnect
continuity is explicit and replay-safe: if a process or transport disappears
before `turn/completed`, that turn fails closed and is never replayed
automatically; ShellX retains the confirmed thread id, and the next prompt can
start a fresh app-server process with `thread/resume`. Deterministic supervisor
coverage proves this fresh-process resume path. The remaining installed-target
canaries are still required before app-server can become the default.

Stopping an active app-server turn sends native `turn/interrupt` with the
server-issued thread and turn ids, allows up to 750 ms for a terminal
`turn/completed` acknowledgement, and then terminates the dedicated provider
process. If the ids are not ready or the JSONL write fails, process termination
remains the fail-closed fallback.

App-server completion is stricter than process completion: ShellX requires a
terminal `turn/completed` notification. A provider or SSH process that exits 0
before that notification is recorded as failed, preventing a disconnected JSONL
channel from becoming a false successful run.

The selected provider is fixed per tab after the first send. The composer
chooses the agent before the run starts; Debug API clients choose provider
permission behavior with `permissionMode` on `/provider-sessions/start` rather
than a separate Tools-pane selector.

Do not use Full Auto on a home directory or an untrusted SSH/WSL target. It is
intended for trusted project folders where the user wants the selected agent to
execute without repeated approval prompts.

When `includeMcpProbe` is true, `mcpPath` is interpreted per provider:
Codex treats it as a probe MCP server script path and wires inline
`-c mcp_servers.shellx_probe.*` overrides. Claude treats it as a
`--mcp-config` JSON file path and adds `--strict-mcp-config`.
Antigravity does not use the generic `mcpPath` probe flag. ShellX gives it a
private per-tab additional workspace for session instructions, but does not add
a host MCP config: 1.1.8, 1.1.10, and 1.1.11 print-mode canaries discovered the
test schema but never sent a real MCP `tools/call`. The 1.1.11 retry attempted
four invocation spellings that its execution backend rejected as unknown tools,
so ShellX correctly rejected the successful process exit as execution evidence.

`includeShellxTooling` defaults to true. `shellxToolExposure` is the newer
per-tab control for the same provider-facing host-tool surface:

- `nativeFirst` (default): provider-native terminal/file/MCP tools are primary,
  while ShellX bridge tools remain available for handoff, preview, assets,
  receipts, and health checks.
- `hostBridge`: same injection behavior as `nativeFirst`, but the user-facing
  intent is explicit ShellX bridge use.
- `hostFull`: same injection behavior for now; reserved for broader host-tool
  diagnostics as ShellX splits tool categories.
- `off`: do not inject `shellx-host-http` into new provider runs for this tab.

For compatibility, `includeShellxTooling: false` is treated as
`shellxToolExposure: "off"` when the newer field is omitted. If both fields are
present, `shellxToolExposure` wins.

For Codex and Claude, ShellX injects the `shellx-host-http` MCP server so
provider sessions can call ShellX host tools. The default prompt advertises
`capabilities_summary`, `search_tool`, `host_read`, `host_act`, `browser_read`,
`browser_act`, `cut_read`, and `cut_act`; exact `fs_*`, `process_*`,
`vision_describe`, `Agent`,
receipt, and related schemas are discovered by name and routed through the
appropriate Host gateway. These host `fs_*` tools execute on the ShellX parent
host filesystem. In WSL/SSH provider tabs they are not the provider machine's
native project filesystem; agents should use their native file tools for files
under the selected WSL/SSH cwd and host `fs_*` only for explicit parent-host
access or host-side atomic/binary operations. Host `fs_*` refuses known
credential stores, shell startup files, SSH/Git config, and persistence paths
even when they are inside the parent host HOME tree. Codex uses
streamable HTTP MCP with `bearer_token_env_var = "SHELLX_MCP_TOKEN"`; ShellX
passes a tab-bound token via process env and uses a sanitized `tabId` query
fallback because current Codex CLI does not expose arbitrary MCP headers.
Claude uses a private `~/.shellx/provider-mcp/` config file with HTTP headers.
Antigravity uses a uniquely named private additional workspace containing a
main-agent definition with compact ShellX session rules; ShellX passes both
`--add-dir` and `--agent` only to the launched process, so ordinary direct
Antigravity sessions do not discover it. That provider must return control to
ShellX for host-scoped Vault, evidence, or cross-provider handoff work.
Write-class MCP tools require the tab-bound token for the claimed tab; the
global MCP token remains accepted for health/read compatibility.
The Host MCP base token is resolved once at startup from `SHELLX_MCP_SECRET`
or the private profile. Profile-backed creation and legacy rotation complete
through atomic private-file replacement before the listener is scheduled;
provider injection and write authorization use the same process-owned token
authority for the rest of that run. If persistence or private-profile validation fails, the
Host MCP listener and ShellX-tool injection fail closed with a bounded error.
For SSH provider sessions, ShellX uses `ssh -R` so remote `localhost:<mcp-port>`
reaches the local ShellX MCP server. Claude gets private MCP configuration
written to the remote host. Codex gets its bearer env staged in a temporary 0600 remote
file that is sourced and removed before provider exec, so the token is not
placed in the SSH command line.

`GET /provider-adapters/state` probes local, WSL, and SSH binaries live when
the corresponding transport query is supplied. For SSH targets, include
`sshHost`, optional `sshPort`, and the matching `sshRemoteRuntime` and
`sshWslDistro`; saved connection scans are used by the UI as cached picker
hints, but the state endpoint can refresh the target directly.
`GET /provider-sessions/state` and `POST /provider-sessions/abort` accept the
same transport fields. Callers must send them for an exact Windows route; the
registry uses them to separate native PowerShell from a named WSL Bash runtime
on the same OpenSSH host.
On native Windows, launch and inventory discovery explicitly include the
official Codex install directory under
`%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin` in addition to the existing
user-local Grok, Claude, Antigravity, Bun, Cargo, and npm roots; the Agent CLIs
card therefore does not depend on a GUI process inheriting an interactive PATH.

`POST /provider-adapters/run` records
`provider-adapter-run-started`, `provider-adapter-run-completed`, and
`provider-adapter-run-failed` events unless `recordEvents` is false.

`POST /provider-sessions/start` starts a background provider process and
returns immediately with `{ ok, run }`. Output is streamed into the
normal debug event ring as `provider-session-event` frames. Each payload
includes `tabId`, `runId`, `providerId`, `kind`, and optional `text`,
`rawType`, `exitCode`, and `error`. ShellX also copies `tabId` into
`_meta.tabId` on emitted Tauri events so the frontend can route provider
output with the same tab filter used by ACP session updates.
`GET /provider-sessions/state` returns the active run plus recent
terminal runs for a tab, including `stdoutLineCount`, `stderrLineCount`,
`lastTextAtMs`, `permissionMode`, `persistSession`,
`providerConversationId`, and terminal `durationMs` when known. It also
returns `storedConversations`, a provider-id keyed map of ShellX's
remembered native conversation ids for that tab.
`POST /provider-sessions/abort` sends the active provider process an
abort signal, records the run as `aborted`, and emits a terminal
`provider-session-event`.

The installed release driver does not spend provider quota to re-test these
generic endpoints. It proves `/provider-adapters/run` reaches its no-spawn
validation and event boundary, then runs the release-owned ShellX JSONL child
fixture through `/provider-sessions/start`. Real provider execution is covered
once, later in the same frozen-candidate run, by the exact provider/transport
matrix below.

The final-release provider matrix uses these routes through
`pnpm release:surface-collect-provider-route`. That create-only collector
first requires its canonical Git checkout to be completely clean, verifies
that both collector sources are tracked, and requires `HEAD` to equal the
candidate's source commit. It then
authenticates to the exact attested ShellX process, refreshes
`shellx.provider-capability-snapshot.v2`, runs the fixed no-tools canary with
ShellX host-tool exposure disabled, consumes the authenticated live event
WebSocket and fails on its explicit lag warning, preserves bounded raw event
payloads plus their SHA-256 identities, verifies the provider-native normalized sequence and exact provider
executable, and proves the route has no active child afterward. Scenario
summaries reference each private route artifact by exact basename, hash, and
byte count; the final receipt composer independently reopens and validates
them. A hand-authored provider/transport pass row is not accepted as route
evidence without a complete internally consistent route artifact. These local
hashes detect drift and bind summaries under a trusted local release operator;
they are not a cryptographic proof against someone able to rewrite the entire
private evidence set.

This is not full ACP parity. Provider sessions map ShellX permission intent
to provider CLI flags, but they do not yet translate provider-native
interactive permission prompts back into ShellX's permission pill/modal
protocol, and they do not replace Grok Build Mode routing.

---

## Experimental Build Mode

`/build <objective>` is the shellX-owned multi-turn workflow. It keeps
host-local state under
`~/.shellx/build-runs/<tab>/<run>/`, asks Grok to write a tab/run-scoped
scratchboard in the connected cwd (`build.<tab>.<run>.md`), and records
typed receipts for file mutations, checkpoints, Agent work, review,
verification, blockers, and completion attempts.

Debug API endpoints:

| Method | Path | Body/query |
| --- | --- | --- |
| POST | `/build/start` | `{ tabId, objective, cwd? }` |
| GET | `/build/state` | `?tabId=<tab>` |
| GET | `/build/receipts` | `?tabId=<tab>` |
| POST | `/build/approve` | `{ tabId, inject? }` |
| POST | `/build/reject` | `{ tabId }` |
| POST | `/build/pause` | `{ tabId }` |
| POST | `/build/resume` | `{ tabId }` |
| POST | `/build/complete` | `{ tabId, summary? }` |
| POST | `/build/receipt` | `{ tabId, kind, summary, actor?, confidence?, data? }` |
| POST | `/build/stop` | `{ tabId }` |
| POST | `/state/session_git/checkpoint` | `{ tabId, cwd?, label? }` |
| POST | `/state/session_git/worktree` | `{ tabId, cwd?, sourceBranch?, newBranch? }` |

Worktree creation resolves the repository's primary checkout even when the
request comes from an existing linked worktree. New lanes are placed under the
single sibling `<repo>-worktrees/<branch-slug>` container rather than creating
one scattered top-level folder per branch.

The host MCP surface adds `build_receipt`, `build_checkpoint`,
`preview_start`, `preview_diagnose`, and `build_complete`. ShellX-owned receipts from
`fs_write`, `fs_append`, `fs_copy`, `fs_delete`, git checkpoints, and `Agent` are trusted;
model-declared receipts are visible in the UI but cannot satisfy hard
destructive-change gates by themselves.

Build Mode Agent calls split wait budgets from kill policy. Use
`wait_budget_ms` to return control when a subagent is still running; this
does not terminate the subagent. Use `max_runtime_ms` only when an
explicit hard wall-clock process cap is desired. Legacy `timeout_ms`
remains accepted as a wait-budget alias for `wait=true`.

For long-running Agent work, shellX also keeps a Build Mode completion
watcher. When an in-flight Agent reaches a terminal state, the watcher
records the normal completion receipts and asks the Build Mode manager to
continue if the run is still active.

---

## 1. Conventions

These conventions are **commitments**, not suggestions. Any new endpoint
that violates them is a bug and must be corrected before merge.

### 1.1 Case

All JSON bodies — request and response, top level and nested — use
**camelCase**. This matches the existing Tauri `invoke` command params
(`wslDistro`, `wslGrokPath`, `mcpServers`). Mixing snake_case and
camelCase across the surface would be a permanent footgun; we lock
camelCase now.

The only exception is the `kind` field inside WS event payloads, which
mirrors whatever string the Tauri event channel uses (e.g.
`grok-acp-event`, `session-update`). These are external identifiers we
do not own.

### 1.2 Path shape

| Pattern | Use |
| --- | --- |
| `GET /state/<noun>` | Read-only snapshot of UI state (header, footer, sessions, subagents, ui, skills, github, github/items, marketplace_health, session_tooling, session_activity) |
| `GET /<resource>` / `GET /<resource>/:id` | Read a domain resource (sessions, settings, panels, autonomy, plan, github) |
| `POST /<resource>` | Create / write a domain resource (sessions, settings, prompt, abort, autonomy) |
| `POST /<resource>/:id/<action>` | Verb-named action on a specific resource (`/sessions/:id/switch`, `/sessions/:id/rename`, `/pr/:n/preview`) |
| `POST /tools/<tool_name>` | Native-host tools (`fs_watch`, `process_list`, `secret_get`) — flat namespace, matches `host_mcp` tool naming |
| `GET /events` (WS) / `GET /events/recent` | Event firehose — both backlog and live |
| `GET /` | Planned discovery index (see §10) |

`GET /state/<noun>` reads must be **side-effect-free** and **safe to
poll**. They return whatever the React layer would render if asked
right now — they don't compute anything new, they read cached state.

### 1.3 Timestamps

Every timestamp is **Unix milliseconds, `i64`**. Never ISO 8601 strings,
never seconds, never floats. The existing `RawEvent.t` is `i64`
unix-millis and this spec extends that. Smaller wire, trivial diffing,
no timezone ambiguity.

If a future field needs higher resolution, add a sibling field with a
clear suffix (e.g. `tNs: u64`). Never reinterpret `t`.

### 1.4 Errors

Non-2xx responses always return a JSON body:

```ts
{
  error: {
    code: string;        // machine-readable, e.g. "session_not_found"
    message: string;     // human-readable, single line, <200 chars
    data?: unknown;      // optional structured detail (path, exitCode, ...)
  }
}
```

`code` values are part of the spec. Add new ones, never repurpose
existing ones. Reserved codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON or missing required field |
| `unauthorized` | 401 | Missing or invalid bearer token |
| `forbidden` | 403 | Loopback-only check failed (non-127.0.0.1 origin) |
| `not_found` | 404 | Resource missing (session, file, PR, plan step) |
| `conflict` | 409 | State precondition failed (e.g. session already active) |
| `unprocessable` | 422 | Valid JSON but semantically invalid (empty prompt, unknown autonomy mode) |
| `gone` | 410 | Resource existed but was deleted/closed |
| `internal` | 500 | Unhandled error in handler — body includes `data.trace` in dev builds |
| `bad_gateway` | 502 | Downstream tool or agent/provider CLI failed |
| `timeout` | 504 | Downstream call exceeded deadline |

The existing handlers return string error bodies on 500, and provider adapter
routes may return route-local `{ ok: false, error }` bodies for provider CLI
preflight failures. Those are grandfathered as v1.0. New endpoints **must**
use the structured shape. A v1.1 migration sweep will retrofit `/connect`,
`/prompt`, `/abort`, and provider debug routes to the structured shape with the old string as
`error.message`.

### 1.5 Idempotency

Endpoints are idempotent **unless explicitly flagged as non-idempotent**
in their section. Idempotent means: repeating the same request with the
same body produces the same observable state — not the same response
body (e.g. a second `POST /sessions` may report "already exists" rather
than creating again). Non-idempotent endpoints get an `Idempotency-Key`
header recommendation; see §1.7.

### 1.6 Versioning

Every response carries `X-API-Version: 1.<minor>.<patch>` (SemVer).
Clients **should** read it on the first response and refuse to proceed
if `major != 1`. The version string mirrors the spec version this file
documents — not the app version.

Migration policy:
- **Patch** bumps: bug fixes, no schema changes.
- **Minor** bumps: new endpoints, new optional fields. Never remove
  fields. Never change a field's type.
- **Major** bumps: breaking. Requires a deprecation window with both
  versions live (`/v1/...` and `/v2/...` path prefixes).

Today (v1.0 frozen surface) everything lives at the root. A v2 will
introduce `/v2/` prefixes; v1 paths remain operative for at least one
release after v2 GA.

### 1.7 `Idempotency-Key` header

For future non-idempotent roadmap routes such as `POST /sessions`,
`POST /skills/install`, and `POST /terminal/spawn`, clients **should** send
`Idempotency-Key: <opaque-string>`. If the server sees the same key
within 10 minutes, it returns the cached result instead of executing
again. Stored in a small in-memory LRU; keys are not persisted across
app restarts.

### 1.8 Content type

All request and response bodies use `Content-Type: application/json`,
UTF-8. WS frames are text frames containing one JSON object per frame —
no binary, no fragmentation across frames. Binary attachments (image
upload for `/prompt`) use base64 strings inside JSON; we are not
shipping multipart in v1.

### 1.9 WS frame envelope

Every WebSocket frame on `/events` uses the existing `RawEvent` shape,
extended with `sessionId`:

```ts
{
  t: number;           // Unix millis (host clock)
  kind: string;        // Tauri event channel, e.g. "grok-acp-event"
  sessionId?: string;  // present on per-session events; absent on
                       // global app events
  payload: unknown;    // arbitrary JSON; usually a parsed agent/provider
                       // frame
}
```

The `sessionId` field is **additive** — v1.0 events without it remain
valid. Subscribers filtering by session **must** treat absence as "global
event, deliver to all listeners."

---

## 2. Discovery — `GET /`

**Purpose:** Self-describing index of every endpoint. Stripe's
`/api-explorer` pattern. A fresh client should be able to bootstrap
knowledge of the surface without reading this spec.

**Response 200:**

```ts
{
  apiVersion: string;            // "1.0.3" etc.
  endpoints: Array<{
    method: "GET" | "POST" | "DELETE" | "WS";
    path: string;                // "/state/header", "/sessions/:id"
    brief: string;               // <=120 chars
    stability: "stable" | "preview" | "experimental";
    introducedIn: string;        // version this landed in
  }>;
  serverTimeMs: number;          // for clock-skew detection
}
```

**Auth:** none (loopback).
**Idempotent:** yes.
**Logging:** request line + status only.
**Driver:** coverage is tracked in `release/surface-driver-plan.json`; the
release harness fails when the generated route inventory and driver plan drift.

---

## 3. Liveness + state reads

All `/state/*` endpoints share these properties:

- `GET` only.
- Idempotent, safe to poll at up to 10 Hz without rate-limiting.
- Return **the snapshot the UI would currently render** — no
  computation, no side effects, no agent calls.
- Empty state returns `200` with the empty/default body, never `404`.
- Logged minimally (request line + bytes-out only; never log body
  contents — these are read-mostly and can be very large).

### 3.1 `GET /health` *(v1.2, exists)*

**Purpose:** Liveness probe.
**Response 200:** `{ ok: true, processId, instanceId?, appVersion, debugApiVersion, buildCommit,
browserProtocolVersion, browserSchemaRevision, browserFeatureFlags,
debugApiPort: 5757, debugUiWebSocketActive, debugUiWebSocketGeneration }`.
Final-candidate harnesses set `instanceId` to a run nonce so evidence can reject
PID reuse or an unrelated ShellX process on the same loopback port.
`debugUiWebSocketActive` is the number of currently open Debug UI event streams.
`debugUiWebSocketGeneration` increases whenever a new stream is accepted, so a
driver can prove that Retry established a fresh renderer connection even when
the active count returns to the same steady-state value.
**Driver:** yes — Mode B uses this as its readiness gate.

### 3.2 `GET /version` *(roadmap, not wired)*

**Purpose:** Server build info, for driver/UI drift detection.
**Response 200:**

```ts
{
  apiVersion: string;     // matches X-API-Version header
  app: { name: string; version: string; commit: string };
  agent: { binary: string; reportedVersion?: string };
  buildTimeMs: number;
}
```

**Driver:** not yet.

### 3.3 `GET /state/header`

What the top header bar renders: cwd, autonomy mode, token gauge,
model badge, daily-cost.

```ts
{
  cwd: string;
  autonomy: "auto";
  tokens: { used: number; max: number };
  model: { id: string; effort: "low" | "medium" | "high" | "xhigh" | "max" };
  dailyCost: { spentUsd: number; capUsd: number | null };
}
```

### 3.4 `GET /state/ui`, `POST /state/ui`

Current debug-visible UI snapshot. Older drafts called this
`/state/sidebar`; the wired route is `/state/ui`. `POST /state/ui`
accepts a partial patch for tab control surfaces. The renderer mirrors
these patches through the debug event stream, so authenticated test
drivers can switch right/bottom tabs before taking `/screenshot`
evidence.

Scenario-wide startup, rendered-link, console, and shutdown claims use a
separate create-only `shellx/release-surface-health-evidence@1` artifact. The
owned Windows/Linux candidate runner now performs these observations itself: an
authenticated loopback collector receives sequenced events from an installed
WebView observer, maps rendered anchors to the exact platform link inventory,
checks each discovered HTTP target, and stays open until WebDriver session
deletion makes the attested candidate PID disappear. Receipt composition
reopens the artifact, re-derives link and console counts, and rejects an
incomplete link-surface set. The older draft validator remains a low-level
schema helper; an operator-authored draft is not accepted as installed runtime
evidence.

The renderer also reads the unpatchable `releaseTestInstance` bit from its
native Debug UI snapshot. Only an exact marker-validated disposable candidate
enables the bundled error observer; that observer mirrors bounded
`console.error`, `window.error`, and unhandled-rejection diagnostics into the
authenticated renderer-error ledger. Normal profiles and browser previews do
not install it. This gives the macOS native-input lane a source-bound console
oracle without exposing a general WKWebView evaluation API.

G16 native user-action drivers also require a private live WebDriver session
bound to the exact candidate process. The runner issues a fresh Debug API
highlight challenge and accepts the session only when WebDriver observes the
same label and both sides observe its cleanup. The create-only binding receipt
records PID/instance identity, source identity, loopback driver origin, DOM
source hash/size, and a hash—not the value—of the session ID. Windows and Linux
use external `tauri-driver`. macOS uses a separate attested host-native helper
because the external Tauri driver does not support WKWebView; no embedded
automation server is shipped in the production binary merely for release
testing.

The reusable external-driver lifecycle owner validates and hashes the exact
`tauri-driver`, installed application, and optional native driver binaries,
uses distinct loopback ports, creates one session for the supplied installed
payload, and always attempts session deletion plus owned driver-process
shutdown. Its create-only `shellx/release-surface-webdriver-lifecycle@2`
receipt hashes the opaque session ID and bounded driver output; it never stores
the raw session ID, environment, or driver log. Total versus retained driver-log
bytes and an explicit truncation flag prevent bounded retention from looking like
complete output. One optional single-owner observer brackets the exact session
DELETE request; observer failure turns the lifecycle red without bypassing
session or driver cleanup. Callback failure, startup exit,
session-delete failure, existing evidence, and successful cleanup are covered
by executable tests. The run-profile owner independently creates an absent,
strictly named disposable profile, configures isolated Debug API/MCP/Vault paths,
verifies its ownership marker, stops only the exact candidate PID/image and
Windows native-driver port identity, checks the target OS for zero Debug
API/MCP listeners, then records create-only
`shellx/release-surface-run-profile-cleanup@1` evidence before removing the
profile. The same owner verifies the macOS process image, checks its loopback
listeners with native `lsof`, and removes the helper-containing profile only
after the Mac driver run. Existing evidence, marker drift, or process identity
drift fail closed and preserve the profile. The Windows/Linux surface-driver entry point
`pnpm release:surface-run-webdriver-candidate` now composes this owner with the
same WebDriver session, waits for the isolated candidate PID/instance, creates
candidate attestation inside that callback, runs the driver matrix without
serializing the session ID, and emits
`shellx/release-surface-webdriver-orchestration@4`. The final-only command now
also requires a `shellx/release-surface-provider-route-batch-plan@1`, validates
the exact platform provider × transport cross-product before launch, saves its
secret-free presets only inside the disposable profile, refuses to overwrite
an existing preset ID, collects every route from the same attested process,
and removes every batch-owned preset after success or failure. Cleanup failure
prevents the route-batch manifest from being written. The runner then binds the create-only
`shellx/release-surface-provider-route-batch@3` manifest. Every declared route
must freshly resolve and hash the target executable. Only the contract's
coverage-minimal live subset opens a provider stream: it covers every provider
globally and every required transport on each installed app OS, while all other
routes record identity-only evidence and spend no provider generation. The lifecycle-wide
health collector writes the matching scenario report only after the exact
session-delete boundary, and the receipt binds both files alongside the
executable, attestation, driver run, route batch, lifecycle, and profile
cleanup. A separate create-only `shellx/release-surface-candidate-teardown@2`
receipt recomposes those post-exit facts against the exact attestation and run
manifest before candidate-dependent cleanup may pass. Windows/Linux bind the
deleted WebDriver session; macOS binds the exact Accessibility-approved native
input receipt and refuses to claim a WKWebView WebDriver lifecycle that does
not exist. `pnpm release:surface-finalize-macos-candidate` then stops the
identity-checked app, proves both loopback listeners absent, and removes the
marker-owned disposable profile. Every inventoried
surface has an executable-lane assignment on each applicable platform; native
signed-candidate execution remains a separate release gate rather than being
inferred from the plan.

The native keyboard driver now covers Help, Escape-close, Command Palette,
Settings, Chat/Terminal toggle, new session, close session, and autonomy cycle.
It sends W3C key actions with Control on Windows/Linux and Meta on macOS,
releases the key input source after every chord, checks exact dialog or
renderer/backing-state effects, and restores its setup state. The first reusable
UI-control driver similarly clicks Chat, Terminal, Logs, and Stderr through W3C
and requires both Debug API state and the active DOM owner to change. The
`shellx/final-surface-driver-plan@2` ledger counts exact surface-platform cells.
These rows run through external WebDriver on Windows/Linux and the attested
host-native helper on macOS.

```ts
{
  panels: { horizontal: [number, number, number]; vertical: [number, number] };
  preview: unknown | null;
  autonomy: string | null;
  bottomTab: string | null;
  leftTab: string | null;
  rightTab: "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files" | null;
  activeTabId: string | null;
  activeTab: {
    tabId: string;
    cwd?: string | null;
    connectionId?: string | null;
    connectionLabel?: string | null;
    connectionTransport?: "local" | "wsl" | "ssh" | string | null;
    shellxToolExposure?: "nativeFirst" | "hostBridge" | "hostFull" | "off";
  } | null;
  debugHighlights: Array<{
    id?: string;
    selector: string;
    label?: string;
    color?: "blue" | "green" | "red" | "yellow" | "orange" | "cyan" | "magenta" | string;
    index?: number;
    text?: string;
    observe?: Array<"value" | "checked" | "selected" | "pressed" | "expanded" | "focused" | "disabled" | "title" | "scrollLeft" | "scrollWidth" | "clientWidth" | "mounted" | "nonempty">;
  }>;
  debugHighlightResults: Array<{
    id: string;
    selector: string;
    label?: string | null;
    color: string;
    status: "resolved" | "missing" | "hidden" | "invalidSelector";
    message?: string | null;
    rect?: { left: number; top: number; width: number; height: number } | null;
    visibleRect?: { left: number; top: number; width: number; height: number } | null;
    clipped?: boolean;
    contentClipped?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    observation?: {
      value?: string;
      checked?: boolean;
      selected?: boolean;
      pressed?: boolean;
      expanded?: boolean;
      focused?: boolean;
      disabled?: boolean;
      title?: string;
      scrollLeft?: number;
      scrollWidth?: number;
      clientWidth?: number;
      mounted?: boolean;
    } | null;
  }>;
  uiRevision: number;
  lastUiPatchMs: number | null;
  lastUiPatchSource: string | null;
  setupGuideDismissed?: boolean;
}
```

When `activeTabId` is patched, ShellX restores the matching `activeTab`
context from `openTabs` when available and clears stale mismatched context
otherwise. Debug agents can compare `uiRevision` and `lastUiPatchSource`
when checking whether a renderer echo or automation patch won a race.
`activeTab.shellxToolExposure` is a non-secret per-tab mode receipt used to
prove that the visible Native, Bridge, Full, or Off choice reached the backing
tab state; it does not imply that an agent was launched or that host tools were
injected into an unrelated direct CLI session.

`POST /state/ui` also accepts renderer commands used by debug drivers.
Most are transient and only broadcast through the debug event stream;
`debugHighlights` and `debugHighlightResults` are also stored in the
returned snapshot so screenshot/video drivers can verify visible
callouts:

```ts
{
  source?: string;         // e.g. "renderer", "qa-replay", "debug-api"
  allowBuildTabMutation?: boolean;
  setupGuideDismissed?: boolean; // reset/dismiss the first-run setup guide
  refreshPastChats?: true;       // rescan the stored-session index after owned fixture changes
  composerMenu?: "connection" | "agent" | "branch" | "close";
  openModal?:
    | "activity"
    | "assets"
    | "buildPlanReview"
    | "close"
    | "connectorInbox"
    | "help"
    | "palette"
    | "plugins"
    | "preview"
    | "pr"
    | "settings"
    | "vault"
    | "workPreview";
  cwdPicker?: true | {
    open?: boolean;        // false closes it
    tabId?: string;        // defaults to activeTabId
    path?: string;         // optional initial remote path
    label?: string;        // optional picker title/connection label
    connectionId?: string; // explicit Local/WSL/SSH preset for listing
  };
  debugClick?: string | {
    selector: string;      // CSS selector in the renderer DOM
    index?: number;        // defaults to first match
    text?: string;         // optional textContent filter
  };
  clickSelector?: string | { selector: string; index?: number; text?: string };
  debugInput?: {
    selector: string;      // CSS selector for input, textarea, select, or contenteditable
    index?: number;        // defaults to first match
    text?: string;         // optional textContent filter for the target
    value: string;         // replaces the current value unless append is true
    append?: boolean;
    key?: string;          // optional keydown/keyup after the input event
    enter?: boolean;       // shorthand for key: "Enter"
  };
  debugDrag?: {
    selector: string;      // CSS selector in the renderer DOM
    index?: number;        // defaults to first match
    text?: string;         // optional textContent filter for the target
    dx?: number;           // drag delta in CSS pixels when endX is omitted
    dy?: number;           // drag delta in CSS pixels when endY is omitted
    startX?: number;       // viewport coordinate; defaults to target center
    startY?: number;       // viewport coordinate; defaults to target center
    endX?: number;         // viewport coordinate; overrides dx
    endY?: number;         // viewport coordinate; overrides dy
    steps?: number;        // pointermove count, 1..20
  };
  debugHighlights?: Array<{
    id?: string;            // stable result key
    selector: string;       // CSS selector in the renderer DOM
    label?: string;         // short callout text shown near the target
    color?: string;         // blue/green/red/yellow/orange/cyan/magenta or #rrggbb/rgb(...)
    index?: number;         // defaults to first match
    text?: string;          // optional textContent filter
    observe?: Array<        // optional release-verification fields
      "value" | "checked" | "selected" | "pressed" |
      "expanded" | "focused" | "disabled" | "title" |
      "scrollLeft" | "scrollWidth" | "clientWidth" | "mounted" | "nonempty"
    >;
  }>;                       // [] clears all callouts
}
```

`debugHighlights` draws non-interactive tutorial/demo callouts over the
running renderer. Targets are selected with CSS selectors plus optional
`index` and `text` filters, then measured from the real DOM with
`getBoundingClientRect()`. `debugHighlightResults` reports the target
`rect`, selector resolution status, and, when a target extends beyond the
visible window, the clipped on-screen `visibleRect` plus `clipped: true`.
`contentClipped` reports overflow inside the matched element using its client
and scroll dimensions, while `viewportWidth` and `viewportHeight` bind the
measurement to the exact renderer viewport.
The optional `observe` fields are a bounded release-verification contract, not
general DOM evaluation. A result is returned only when the matched element
explicitly declares the same field in `data-shellx-release-observe`. `nonempty`
is a boolean-only input projection for proving sensitive draft transitions
without returning their bytes. Input values, element `title` attributes, and
explicitly declared HTTPS anchor `href` values are capped at 256 characters.
The `href` field is returned only for an `HTMLAnchorElement` that declares
`data-shellx-release-observe="href"`, is outside a sensitive owner, and resolves
to HTTPS; other schemes fail closed. A mounted non-zero-size anchor outside the
current viewport may return this declared observation with `status: "hidden"`
and `visibleRect: null`; it is observation-only and cannot be used as a native
action target. Input
values are refused for password, hidden, file, payment, or one-time-code
controls, and both text fields are refused below `data-shellx-sensitive="true"`.
`mounted` is a boolean-only projection of an element's explicitly declared
`data-shellx-release-mounted="true|false"` state; it cannot expose arbitrary
attributes or text.
Unknown fields are
dropped by the backend and undeclared or type-mismatched results fail the
release driver. This keeps macOS native-input verification useful without
enabling arbitrary renderer JavaScript or turning the Debug API into a generic
form-value reader.
Automation should wait for every required item to report
`status: "resolved"` before recording or capturing screenshots, and clear
callouts with `debugHighlights: []` before switching panels or modals.

Six fixed release-fixture commands are accepted only when ShellX was launched
as an attested isolated test instance. `releaseTestResetBrowserPersonalLock:
"owned-pin-lifecycle"` clears the owned Personal Browser Lock verifier.
`releaseTestHostMcpChild: "spawn-owned"` creates one inert Host MCP child for
the current active tab only when that tab has no live Host MCP child;
`"clear-owned"` terminates and forgets only the exact release-owned child.
Those two fields are consumed before the UI patch is broadcast.
`releaseTestRendererCrash: true` is broadcast once without entering stored UI
state; it throws the fixed `SHELLX_RELEASE_TEST_RENDERER_CRASH_035` render error
so an installed-candidate driver can prove both ErrorBoundary recovery actions.
`releaseTestVoiceCapture: "recording" | "clear"` is also broadcast without
entering stored UI state. It drives only the real voice-chat MicButton state
machine, allowing installed-candidate drivers to prove the cancel, stop, and
per-tab voice-off path without requesting the operator microphone or invoking
a transcription provider.
`debugUpdateFixture: "owned-check" | "owned-available" | "clear"` projects a
fixed signed-update state into all three production updater surfaces. Their
real check and install handlers stop at an observable boundary before any
network request, application-file replacement, or relaunch.
`releaseTestExternalEffectBoundary: "pr-create" | "artifact-archive" | "clear"`
projects only the two fixed external-effect controls. The PR action submits a
complete explicitly approved draft through `POST /github/pr/create`, whose
isolated release boundary returns before resolving `gh`, spawning a subprocess,
or contacting GitHub. The artifact action enters its production click handler
and returns before opening the operating-system save picker, walking session
files, or writing an archive. All six fields
are never persisted and return
`404 release_test_route_unavailable` on normal app instances.

The fixed `debugRendererFixture: { id: "right-rail-git-lifecycle" }`
projection also covers the Tooling environment card. Its Refresh action
advances a bounded sequence against the owned snapshot, while Trace records a
pre-filesystem export receipt; neither action invokes Grok CLI diagnostics nor
writes a trace artifact.

`allowBuildTabMutation` defaults to `false`. While a tab has an active
Build run, debug UI patches may still focus tabs, open panels, and capture
screenshots, but they may not silently change that tab's connection or cwd
context unless the caller explicitly opts in.

These transient commands cover the user-facing surfaces that need
screenshot-driven QA:

| Surface | Debug command |
| --- | --- |
| Right rail tabs | `rightTab` |
| Bottom panel tabs | `bottomTab` |
| Session tab focus | `activeTabId` |
| Composer connection/agent/branch pickers and close | `composerMenu` |
| Cwd picker surface | `cwdPicker` |
| App-level modals: Settings, Help, Plugins, Connector Inbox, Asset Board, Preview Center, Activity, PR, Vault | `openModal` |
| Already-visible click targets | `debugClick` |
| Text fields, textareas, selects, and contenteditable controls | `debugInput` |
| Already-visible drag targets such as splitters, resize handles, and graph nodes | `debugDrag` |
| Tutorial/demo callouts and explicitly declared bounded release observations | `debugHighlights` |

The wired detail variants are `GET /state/skills`, `GET /state/files`,
`GET /state/github`, and `GET /state/github/items`. `GET /state/projects`
remains a roadmap route. RightRail writes
`rightTab` here when the user selects Tasks, Tooling, Git, Preview,
Plan, or Files. `leftTab` is state-only compatibility data; the current
left rail is a project/chat tree, so row-level testing uses
`debugClick` plus stable `data-debug-id` selectors.

### 3.5 `GET /state/footer`

Aggregate counters and connection state.

```ts
{
  connection: "connected" | "disconnected" | "connecting";
  sessions: { running: number; needsInput: number; done: number };
  currentSession: { id: string; autonomy: string; tokens: { used: number; max: number } } | null;
  dailyCost: { spentUsd: number; capUsd: number | null };
  wsEndpoint: string;
}
```

### 3.6 `GET /state/sessions`

Per-tab footer snapshot list — one entry per tab the orchestrator
currently tracks. Drives the LeftRail "Open chats" list and the
multi-tab observability surfaces.

```ts
{
  count: number;
  tabs: Array<{
    tabId: string;
    sessionId: string | null;
    cwd: string | null;
    isWsl: boolean;
    isSsh: boolean;
    wslDistro: string | null;
    sshHost: string | null;
    linuxHome: string | null;
    hasSession: boolean;
    hasActiveChild: boolean;
    authHealthy: boolean;
    authFailureHint: string | null;
    mcpServerCount: number;
    mcpServersSource: string | null;
    permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | null;
    shellxToolExposure?: "nativeFirst" | "hostBridge" | "hostFull" | "off";
    detectedMaxContextLength: number | null;
    providerId?: "codex-cli" | "claude-code" | "antigravity-cli" | null;
    providerRunId?: string | null;
    providerPhase?: "starting" | "streaming" | "completed" | "failed" | "aborted" | null;
    providerTransportKey?: string | null;
    providerConversationId?: string | null;
    sshPort?: number | null;
    sshKeyVaultRef?: string | null;
  }>;
}
```

Note: the legacy `{ sessions, activeSessionId }` shape predated the
multi-tab refactor (#178/#284) and is no longer emitted. External
drivers should read from `tabs[].tabId` / `tabs[].sessionId` and
treat the first tab whose `hasActiveChild=true` as the user's
focused session (or read `/state/header` for the active tab).
Provider-only tabs use the same list shape and add `provider*` fields
when the active/recent process is Codex CLI, Claude Code, or Antigravity
CLI instead of a Grok ACP child.

### 3.7 `GET /state/tabs/report`

Compact operational board for debug drivers and release QA. It merges
the renderer's open-tab inventory with backend Grok/provider session
state, so idle staged tabs and running CLI provider tabs appear in one
scan-friendly response. This route is read-only and never starts scans,
sessions, or probes.

```ts
{
  generatedAtMs: number;
  activeTabId: string | null;
  count: number;
  runningCount: number;
  finishedCount: number;
  needsAttentionCount: number;
  tabs: Array<{
    tabId: string;
    title: string | null;
    isFocused: boolean;
    agentId: "grok" | "codex-cli" | "claude-code" | "antigravity-cli" | "unselected" | string;
    agentLabel: string;
    sessionKind: "grok" | "provider" | "providerStoredConversation" | "ui" | string;
    status: "idle" | "starting" | "running" | "connected" | "finished" | "failed" | "aborted" | "aborting" | string;
    phase: "starting" | "streaming" | "completed" | "failed" | "aborted" | null;
    surface: {
      transport: "local" | "wsl" | "ssh" | string;
      cwd: string | null;
      connectionId: string | null;
      connectionLabel: string | null;
      wslDistro: string | null;
      sshHost: string | null;
      sshPort: number | null;
    };
    sessionId: string | null;
    providerRunId: string | null;
    projectId: string | null;
    branchName: string | null;
    isSending: boolean;
  }>;
}
```

Use this before driving a window with many concurrent tabs. Use
`/state/sessions` when the raw registry details are needed.

### 3.8 `GET /state/agent_runs`

Global agent run manager for supervising many ShellX tabs. It joins
`/state/tabs/report`, provider-session run snapshots, the ShellX host
subagent mirror, and provider stream evidence into one read-only board.
The route never starts scans, sessions, or provider probes.

```ts
{
  generatedAtMs: number;
  activeTabId: string | null;
  summary: {
    runCount: number;
    runningCount: number;
    tabSessionCount: number;
    providerRunCount: number;
    shellxSubagentCount: number;
    observedNativeSubagentCount: number;
  };
  nativeSubagents: {
    visibility: "observed" | "notExposed" | string;
    observedCount: number;
    note: string;
  };
  runs: Array<{
    id: string;
    kind: "tab-session" | "provider-run" | "shellx-host-subagent" | "provider-native-subagent" | string;
    scope: "shellx-tab" | "provider-cli" | "shellx-host" | "provider-native" | string;
    tabId?: string | null;
    providerId?: "codex-cli" | "claude-code" | "antigravity-cli" | string;
    subagentId?: string;
    parentSubagentId?: string;
    toolCallId?: string;
    status: string;
    active: boolean;
    surface?: { transport?: "local" | "wsl" | "ssh" | string; cwd?: string | null };
    tokens?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      updatedAtMs?: number;
    } | null;
    metrics?: {
      firstResponseAtMs: number | null;
      firstTextAtMs: number | null;
      firstActionAtMs: number | null;
      firstSuccessfulActionAtMs: number | null;
      timeToFirstResponseMs: number | null;
      timeToFirstTextMs: number | null;
      timeToFirstActionMs: number | null;
      timeToFirstSuccessfulActionMs: number | null;
      toolCallCount: number;
      toolSuccessCount: number;
      toolFailureCount: number;
      subagentCount: number;
      lineageLinkedEventCount: number;
    };
    nativeVisibility?: "observed" | "notExposed" | "notApplicable" | "shellxHost" | string;
    updatedAtMs?: number;
  }>;
}
```

Provider-run metrics are derived from normalized event metadata. They expose
timings, counts, and cumulative provider-reported token categories, but never
transcript text, tool arguments/results, or private artifact bodies. Missing
stream fields remain `null` or zero rather than being inferred as provider
capability.

Provider-native subagents are reported only when the provider CLI emits
an identifiable subagent/tool-use event. Normalized `subagent` events are
collapsed by their structured subagent/tool-call identity, retain an exposed
parent subagent ID, and advance from active to the provider-reported terminal
status instead of appearing as duplicate observations. ShellX does not manage hidden
provider-native subagents; it reports `nativeSubagents.visibility:
"notExposed"` when the stream does not expose them.

### 3.9 `GET /state/skills`, `GET /state/github`, `GET /state/github/items`

Detail-rich snapshots of each domain. Each mirrors what the UI tab
would render. Schemas omitted for brevity — they expand the
corresponding sub-objects in §3.4 with per-row metadata (paths,
tool counts, PR titles, etc.). Implementers must add typed examples to
a fixture under `tests/` so the driver can pin them.

### 3.10 `GET /state/session_tooling?tabId=<tab>`

Read-only mirror of the right-rail Tooling tab. It returns the active
tab transport/session metadata, global MCP desired state, and the
environment-specific health rows last produced for that tab. It does
not create missing sessions or start probes; `/connect` schedules probes
for live debug-api sessions. If `tabId` is omitted, shellX resolves the
current UI `activeTabId` and falls back to `default` only when no active
tab is known.

```ts
{
  tabId: string;
  session: {
    transport: "local" | "wsl" | "ssh" | "none";
    cwd: string | null;
    hasActiveChild: boolean;
    sessionId: string | null;
    debug: unknown;
  };
  desired: Array<unknown>; // MCP marketplace entries with installed/enabled state
  health: Array<{
    entryId: string;
    tabId: string;
    transportKey: string;
    status: "checking" | "running" | "missing" | "failed" | string;
    launcher: string;
    installHint?: string | null;
    stderrTail?: string | null;
    lastCheckMs: number;
  }>;
}
```

### 3.11 `GET /state/environment?tabId=<tab>&force=0|1&cwd=<path>`

Returns the same Environment board model rendered by the right rail. For
Grok sessions this runs Grok-native diagnostics (`grok mcp doctor --json`
and `grok inspect --json`); it does not require model credits and does
not publish anything. For Codex CLI,
Claude Code, and Antigravity provider tabs it returns a provider-neutral
environment payload with provider session readiness plus the same
Local/WSL/SSH tooling probes. `/state/grok_environment` is kept as a
compatibility alias.

When a tab is not connected yet, callers may pass `cwd` so the passive
Preview setup checks can still inspect the selected project folder.

```ts
{
  tabId: string;
  status: "idle" | "pass" | "warn" | "fail";
  checkedAtMs: number;
  transport: "local" | "wsl" | "ssh" | "none" | string;
  cwd?: string | null;
  sessionId?: string | null;
  doctor?: {
    summary: {
      status: "pass" | "warn" | "fail";
      healthyCount: number;
      failingCount: number;
      totalCount: number;
    };
    servers: Array<{
      name: string;
      transport: string;
      target: string;
      source: string;
      healthy: boolean;
      category: "healthy" | "authRequired" | "connectionFailed" |
        "commandMissing" | "handshakeFailed" | "failed";
      detail?: string | null;
      hint?: string | null;
    }>;
  } | null;
  inspect?: {
    grokVersion?: string | null;
    projectTrusted: boolean;
    instructionCount: number;
    skillCount: number;
    pluginCount: number;
    mcpServerCount: number;
    lspServerCount: number;
  } | null;
  setup: {
    summary: {
      status: "idle" | "pass" | "warn" | "fail";
      readyCount: number;
      attentionCount: number;
      totalCount: number;
    };
    checks: Array<{
      id: string;
      label: string;
      status: "idle" | "pass" | "warn" | "fail";
      detail: string;
      command?: string | null;
      docs?: string | null;
    }>;
  };
  readiness: {
    summary: {
      status: "idle" | "pass" | "warn" | "fail";
      readyCount: number;
      attentionCount: number;
      totalCount: number;
    };
    checks: Array<{
      id: string;
      label: string;
      feature: string;      // ShellX feature affected by this tool/check
      status: "idle" | "pass" | "warn" | "fail";
      required: boolean;    // true when the feature cannot work without it
      detail: string;       // agent-readable reason
      command?: string | null;
      docs?: string | null;
    }>;
  };
  apiKeyHint: {
    preferredEnv: "XAI_API_KEY";
    legacyEnv: "GROK_CODE_XAI_API_KEY";
    preferredPresent: boolean;
    legacyPresent: boolean;
    detail: string;
  };
  trace: { available: boolean; sessionId?: string | null; detail: string };
  error?: string | null;
}
```

`setup` is a passive project-folder check used by the Environment
Board. It detects static HTML previewability, package-manager install
commands, common web preview scripts, and Expo web dependencies such as
`react-dom` and `react-native-web`. It reports setup commands; it does
not run them.

`readiness` is the agent-readable environment tooling map. It explains which
missing Local/WSL/SSH commands or host tools affect ShellX features such as
Work Preview, Preview Doctor screenshots, Git evidence/checkpoints, ShellX
host MCP handoffs, and agent diagnostics. Agents should inspect this section
before doing a deep investigation of a failed preview/tool workflow.

`POST /state/environment/trace_export` accepts `{tabId}` and runs
`grok trace --local --json <sessionId>` for the active tab when Grok trace
is available. It is a local-only audit export; it does not upload a trace.
`/state/grok_environment/trace_export` is kept as a compatibility alias.

### 3.12 `GET /state/session_activity?tabId=<tab>`

Read-only source payload plus a compact derived report for the Activity
Browser. The response exposes the local evidence ShellX can currently
inspect: session `hunk_records.jsonl` for verified file hunks plus a
filtered `updates.jsonl` subset containing only tool-call records. Local
and WSL sessions resolve to the user's reachable `~/.grok/sessions/...`
folder. SSH sessions return `remote-not-mirrored` until ShellX mirrors
remote trace artifacts locally.

Optional restored-session parameters mirror the Tauri command:
`sessionId`, `sessionCwd` (or `cwd`), and `transport`. When a tab is no
longer live, local sessions can still be inspected if the caller supplies
the durable native session id and cwd.

The renderer Activity Browser also exposes a local search field at
`[data-debug-id='activity-search']`. It filters the condensed Files, Graph,
Evidence, Timeline, and Summary views client-side from the same activity
action stream returned by this endpoint.

```ts
{
  tabId: string;
  sessionId: string | null;
  cwd: string | null;
  transport: "local" | "wsl" | "ssh" | "unknown";
  status: "ready" | "missing-hunk-records" | "remote-not-mirrored" | string;
  readable: boolean;
  scratchDir: string | null;
  hunkRecordsPath: string | null;
  hunkRecordsJsonl: string;
  updatesPath: string | null;
  updatesJsonl: string; // tool_call / tool_call_update lines only
  note: string | null;
  report: {
    schemaVersion: "shellx.sessionActivity.report.v1";
    summary: {
      total: number;
      verified: number;
      observed: number;
      inferred: number;
      changes: number;
      readsAndSearches: number;
      git: number;
      commands: number;
    };
    changes: ActivityReportItem[];
    readsAndSearches: ActivityReportItem[];
    git: ActivityReportItem[];
    commands: ActivityReportItem[];
  };
}

type ActivityReportItem = {
  path: string;
  relativePath: string;
  name: string;
  count: number;
  confidence: "verified" | "observed" | "inferred";
  kinds: Record<string, number>;
  newestTimestampMs: number | null;
  query: string | null;
  command: string | null;
  source: "hunk_record" | "grok_update" | "shell_command" | string;
}
```

### 3.13 `GET /state/files?tabId=<tab>&path=<absolute>`

Read-only mirror of the Files pane/cwd picker. The route returns the same
one-level listing as the `list_project_files` Tauri command, including WSL and
SSH provider context. If `path` is omitted, ShellX uses the tab's active cwd.
For a saved connection before a session is active, pass `connectionId=<id>` and
an absolute remote path. Hidden entries are skipped unless
`includeHidden=true`.

```ts
{
  tabId: string;
  path: string;
  connectionId: string | null;
  includeHidden: boolean;
  count: number;
  entries: Array<{
    name: string;
    kind: "file" | "dir";
    size: number;
    git_status: string | null;
  }>;
}
```

### 3.14 `GET /state/preview`, `GET /state/plan`, `GET /state/panels` *(roadmap, not wired)*

- `preview`: what the right pane is currently showing (path/url + kind).
- `plan`: current plan-mode step list with statuses (mirrors §15).
- `panels`: persisted panel sizes (mirrors §8).

---

## 4. Session lifecycle

Multi-session is the cornerstone refactor in
the legacy UI design proposal. The v1.0
`/connect` endpoint is **session-singleton** and is preserved; the new
endpoints below introduce explicit session identifiers and run in
parallel with the singleton.

`/connect` accepts `tabId` / `tab` / `tab_id` / `sessionId` in the query or
body. If no id is supplied it operates on the sentinel id `"default"`.
Calling `/connect` for an already-active tab is a no-op and returns
`alreadyActive: true`; pass `restart: true` only when intentionally replacing
that child process.

Only one `/connect` may start for a tab at a time. A concurrent attempt fails
fast with `409` and `{ ok: false, error: "connect_in_progress", tabId }`
instead of waiting behind the first provider handshake. `POST /abort` can
cancel that handshake without waiting for the tab's session mutex: it returns
`202` with `connectCancellationRequested: true` and
`registryRemovalPending: true`, while the original `/connect` returns `409`
with `error: "connect_cancelled"` after killing any partially started child.
Cleanup is asynchronous from the abort caller's perspective; retry `/connect`
only after the cancelled attempt has returned or `/state/sessions` no longer
contains the tab. A soft-cancel request cannot retain a provider session that
never finished starting, so this `202` response reports `keepSession: false`
and preserves the requested value separately as `requestedKeepSession`.

The body accepts saved `connectionId`, WSL fields (`wslDistro`,
`wslGrokPath`), or SSH fields (`sshHost`, optional `sshPort`,
`sshKeyVaultRef`, `remoteGrokPath`). Inline WSL and SSH fields are mutually
exclusive.

### 4.1 `POST /sessions` *(roadmap, not wired)*

Create a new session.

**Request:**

```ts
{
  cwd: string;
  autonomy?: "auto";
  branch?: string;             // create/checkout this branch
  worktree?: boolean;          // create a git worktree (default true if branch given)
  wslDistro?: string;
  wslGrokPath?: string;
  mcpServers?: unknown[];
  title?: string;              // optional pre-title; auto-titled later
  idempotencyKey?: string;
}
```

**Response 201:** the full session object from §3.6.
**Error 409 `conflict`:** session with matching `idempotencyKey` already
exists; returns the existing one.
**Error 502 `bad_gateway`:** agent/provider CLI failed to spawn — body includes
`data.stderr`.
**Idempotent:** with `idempotencyKey`, yes; without, **no** (each call
creates a new session).
**Driver:** target for the v1.1 driver milestone — Mode B currently
only exercises the singleton `/connect`.

### 4.2 `GET /sessions` *(roadmap, not wired)*

List sessions. Same shape as `GET /state/sessions` §3.6.
**Idempotent:** yes.

### 4.3 `GET /sessions/:id` *(roadmap, not wired)*

One session's full state. **Error 404 `not_found`** if id unknown.

### 4.4 `DELETE /sessions/:id` *(roadmap, not wired)*

Tear down a session: abort if running, stop the agent child, optionally
prune the worktree.

**Query:** `?pruneWorktree=true` (default `false`).
**Response 204:** no body.
**Idempotent:** yes — second delete returns `200 { alreadyGone: true }`.

### 4.5 `POST /sessions/:id/switch` *(roadmap, not wired)*

Make the named session the UI's active one. No-op if already active.
**Response 200:** `{ activeSessionId: string }`.

### 4.6 `POST /sessions/:id/rename` *(roadmap, not wired)*

```ts
{ title: string }
```

Title length capped at 120 chars. `unprocessable` if empty.

---

## 5. Prompt + abort + autonomy

### 5.1 `POST /prompt` *(v1.0, exists — extended)*

**Existing body:** `{ prompt: string }`.
**v1.1 extension (additive):**

```ts
{
  prompt: string;
  sessionId?: string;            // alias of tabId; defaults to "default"
  tabId?: string;
  attachments?: Array<
    | { kind: "file"; path: string }
    | { kind: "image"; base64: string; mimeType: string }
  >;
  idempotencyKey?: string;
}
```

Attachments translate to ACP `image` / `resource` PromptParts inside
the agent call. The `path` form must resolve inside the session cwd
(otherwise `403`).

**Response:** unchanged — `{ ok: true, queued: <prompt> }`. Events stream over
WS. If the tab has not been connected, returns `409 session_not_connected`.

**Idempotent:** with `idempotencyKey` and same `sessionId`, yes. Without,
**no** — each call sends a new turn.

**Driver:** covered by the generated release surface plan and installed
Debug-API driver family.

### 5.2 `POST /abort` *(v1.0, exists — extended)*

Default behavior is a hard abort: it cancels the active prompt, removes the
tab's session registry entry, and the next `/prompt` for that tab requires a
fresh `/connect`.

Hard abort is idempotent when the selected tab is already absent. It returns a
successful no-registry postcondition without creating a temporary session row,
starting a child, or changing `/state/sessions`.

Soft prompt-only cancel keeps the session entry alive. Use any one of:

```ts
POST /abort?keepSession=1
POST /abort { soft: true }
POST /abort { keepSession: true }
POST /abort { cancelPromptOnly: true }
```

Optional tab selectors are accepted as query/body `tabId`, `tab`, or
`tab_id`. The normal completed-abort response shape is:

```ts
{ ok: true; tabId: string; registryRemoved: boolean; keepSession: boolean }
```

When the tab is still inside `/connect`, the abort is accepted immediately and
cleanup continues outside the request that signalled it:

```ts
{
  ok: true;
  tabId: string;
  registryRemoved: false;
  registryRemovalPending: true;
  keepSession: false;
  requestedKeepSession: boolean;
  connectCancellationRequested: true;
  abortedTabTasks: number;
}
```

That startup-cancellation response uses HTTP `202`. The matching `/connect`
request returns `409 connect_cancelled` after its child cleanup completes.

`POST /disconnect` is a semantic alias for hard `/abort` unless one of the
soft-cancel flags above is supplied.

**Driver:** normal installed connect/abort lifecycle is covered by the Debug API
release driver; startup cancellation and generation safety are covered by Rust
concurrency tests.

### 5.3 `POST /autonomy`

```ts
{
  mode: "bypassPermissions" | "auto";
  sessionId?: string;            // alias of tabId
  tabId?: string;
}
```

Sets the Grok/ACP tab to the ShellX Full Auto mode used when a Grok child is
next spawned. Older migration/diagnostic wire values remain accepted at the
transport boundary but are not user-facing modes. Provider CLI sessions do not read this endpoint
directly; Debug API clients should pass `permissionMode` on
`/provider-sessions/start`. For a running Grok session the response includes
`appliesAfterReconnect: true` because the CLI flag is already baked into argv.

`auto` / `bypassPermissions` is Full Auto. It should be displayed and treated
as a warning-level mode because shell and host-tool actions can proceed without
per-action user approval.

**Response 200:** `{ ok, mode, tabId, appliesAfterReconnect }`.

### 5.4 `GET /autonomy?sessionId=<id>` *(roadmap, not wired; use `GET /state/ui`)*

Returns `{ mode, sessionId }`.

### 5.5 `POST /permissions/:reqId/respond`

```ts
{ outcome: "allow" | "allow_always" | "deny" }
```

Resolves one already-pending provider permission request by opaque request id.
This is an internal provider-compatibility route, not a ShellX autonomy mode.
Possession of the Debug API bearer is sufficient authority, so external tools
must not call it unless the operator explicitly delegated that exact decision.
Unknown, expired, or already-resolved ids return `404`; unrecognized outcomes
fail closed to deny.

---

## 6. Settings

### 6.1 `GET /settings`

```ts
{
  density: "compact" | "default" | "comfortable";
  theme: "black" | "black_warm" | "bright";
  chatFontPx: number;               // 12..26
  githubGhBinary: string;           // advanced compatibility setting
}
```

### 6.2 `POST /settings`

Partial update. Unknown fields are ignored and the stored file is
normalized back to the supported keys above.

**Idempotent:** yes.

**Logging:** values are not expected to contain secrets. GitHub PATs live
in the Vault / marketplace path, not in settings.

---

## 7. Panels

`GET /panels` / `POST /panels` mirror `localStorage` so external drivers
can predict the UI layout.

```ts
{
  horizontal: [number, number, number]; // left, center, right percentages
  vertical: [number, number];           // output, bottom percentages
}
```

**Idempotent:** yes. Right-rail active tab is tracked separately via
`POST /state/ui` with `rightTab`.

---

## 8. Preview pane

### 8.1 `POST /preview`

Set the renderer's right Preview pane target. This route records and
broadcasts preview state for the ShellX UI/debug drivers; file path and
URL safety checks are enforced later by the desktop preview commands
that actually read or render the target.

Send JSON `null` to clear the current target and restore an empty Preview
baseline. The clear is broadcast to the renderer as well as stored by the
Debug API, so automation can restore either an empty or populated starting
state exactly.

```ts
{
  // Exactly one of:
  path?: string;        // renderer preview target path
  url?: string;         // renderer preview target URL
  // Optional:
  kind?: "code" | "markdown" | "image" | "pdf" | "diff" | "html" | "expo";
  tabId?: string;      // exact tab/provider context for WSL/SSH file reads
  sessionCwd?: string; // cwd fallback for relative preview paths
  // Auto-detected by extension if omitted.
}
```

**Errors:** `bad_request` if both/neither given; `forbidden` if path
escapes cwd; `not_found` if path missing.

### 8.2 `GET /preview`

Returns the current preview target (see §3.9).

### 8.3 Work Preview

Host-owned preview runner for generated web work. It binds previews to
loopback only and records the process/server state for auditability.

```ts
POST /preview/work/start?tabId=<tab>
{
  tabId?: string;
  cwd: string;
  kind?: "auto" | "static" | "web" | "expo";
  entry?: string;       // optional static HTML entry relative to cwd
}

POST /preview/work/stop?tabId=<tab>
{ tabId?: string }

GET /preview/work/state?tabId=<tab>
GET /preview/work/logs?tabId=<tab>

GET /preview/work/diagnose?tabId=<tab>
POST /preview/work/diagnose?tabId=<tab>
{
  tabId?: string;
  browserEvents?: Array<{ level: string; message: string; source?: string; url?: string }>;
}
```

`auto` detects Expo, package `scripts.dev`, or `index.html`. Static
previews may pass `entry` to open a specific generated `.html` file.
Web app
previews launch the detected dev script with loopback `PORT`/`HOST`
environment variables; arbitrary shell commands are intentionally not
accepted by this API.

Preview Doctor (`/preview/work/diagnose`) inspects the active preview
URL, HTTP status/body, preview process logs, optional shellX-captured
browser events, and visual evidence. The host captures the rendered
preview URL itself with Edge, Chrome, or Chromium when available and
returns a PNG path that agents can pass to
`vision_describe`. `/build` reviewers and verifiers should use it for
UI/web/app work before `build_complete`.

Preview QA Studio is the evidence layer on top of Work Preview and
Preview Doctor. It records a `shellx.preview.qa.v1` receipt from Preview
Doctor output plus optional flow checks such as click-throughs, broken
links, unresponsive buttons, layout overflow, and responsive screenshot
coverage. Release readiness uses this as the UI/web/app QA gate; basic
users still see the simpler Work Preview and Preview Doctor controls.

Agents should use the host MCP `preview_start` tool to activate Work
Preview for `/build` UI gates, then call `preview_diagnose`. Starting
`npm`, Vite, Next, or Expo servers through a generic shell subagent does
not populate shellX Work Preview state and is not enough for the visual
audit gate.

Diagnostic responses also include:

```ts
{
  screenshotPath: string | null;
  screenshotWidth: number | null;
  screenshotHeight: number | null;
  screenshotBrowser: string | null;
  screenshotError: string | null;
}
```

State shape:

```ts
{
  tabId: string;
  cwd: string | null;
  kind: "staticHtml" | "webApp" | "expoWeb" | null;
  status: "idle" | "starting" | "running" | "failed" | "stopped";
  url: string | null;
  command: string | null;
  taskId: string | null;
  pid: number | null;
  error: string | null;
  logs: Array<{ t: number; stream: string; line: string }>;
}
```

---

## 9. Skills / connectors

### 9.1 `GET /skills` *(roadmap, not wired; use `GET /state/skills`)*

Returns the full skills inventory (same content as `/state/skills` but
without the sidebar wrapper). Schema:

```ts
{
  skills: Array<{
    name: string;
    source: "builtin" | "mcp" | "user";
    transport?: "stdio" | "http";       // mcp only
    enabled: boolean;                   // per active session
    installedGlobally: boolean;
    description: string;
    toolCount?: number;                 // mcp only
    authState?: "ok" | "required" | "failed";
    manifestPath?: string;
  }>;
}
```

### 9.2 `POST /skills/:name/toggle` *(roadmap, not wired)*

```ts
{ enabled: boolean; scope?: "session" | "global"; sessionId?: string }
```

Default `scope: "session"`. Global toggle requires `scope: "global"`
and updates the on-disk config.

### 9.3 `POST /skills/install` *(roadmap, not wired)*

```ts
{
  source:
    | { kind: "marketplace"; id: string }
    | { kind: "git"; url: string; ref?: string }
    | { kind: "local"; path: string };
  idempotencyKey?: string;
}
```

**Response 202:** `{ jobId: string }`. Install runs asynchronously;
progress streams as WS events with `kind: "skill-install"` and
`payload.jobId`.

**Non-idempotent** without `idempotencyKey`.

### 9.4 Outside connectors

Outside connectors are user-facing channels such as Telegram and
Discord bots. Secrets are never posted to these routes; connector
bodies contain Vault key references only.

```ts
type OutsideConnector = {
  id: string;
  label: string;
  enabled: boolean;
  provider:
    | { kind: "telegram"; botTokenVaultKey: string; allowedChatIds: string[] }
    | { kind: "discord"; botTokenVaultKey: string; allowedTargetIds: string[] };
  target:
    | { mode: "activeTab" }
    | { mode: "fixedTab"; tabId: string };
  dispatchMode: "inbox" | "autoPrompt";
  requireApproval: boolean;
  createdMs: number;
  updatedMs: number;
  lastTestMs?: number | null;
  lastError?: string | null;
};
```

`dispatchMode` and `requireApproval` are independent. Selecting Session chat
does not disable per-message review; new connectors default to
`requireApproval: true`, and Auto-dispatch requires a separate operator choice.

Routes:

- `GET /outside-connectors` → `{ connectors: OutsideConnector[] }`
- `GET /outside-connectors/capabilities` → `{ capabilities: OutsideConnectorCapabilities[] }`
- `GET /outside-connectors/events?limit=50` → `{ events: OutsideConnectorEvent[] }`
- `POST /outside-connectors` with `OutsideConnector` → saved connector
- `DELETE /outside-connectors/:id`
- `POST /outside-connectors/:id/test` → `{ reachable, provider, latencyMs, identity, error }`
- `POST /outside-connectors/:id/simulate` with `{ senderId, conversationId?, guildId?, text }` → recorded inbound event

Telegram test calls Bot API `getMe` using the Vault reference named
`botTokenVaultKey`. Discord test calls `GET /users/@me` using the bot-token
Vault reference named `botTokenVaultKey`.

Telegram `autoPrompt` is a live session-chat connector. It requires an enabled
connector, an allowlisted chat id, and either a fixed tab or the
renderer-published active tab. shellX records the inbound event, sends the
message to the target ShellX session—either live Grok ACP or a Codex, Claude,
or Antigravity provider session—and returns the active session's captured text reply with Telegram
`sendMessage`, and sends a referenced local image path with `sendPhoto` when
the reply includes one. Discord supports the same `autoPrompt` routing for
allowlisted direct messages and returns the captured text reply through its bot
API. Provider-session routing reuses the selected tab's recorded execution
target, permission mode, and ShellX tool-exposure policy. It resumes the exact
provider conversation when that identity is available and otherwise starts a
fresh run in the same tab and target rather than continuing an unrelated global
conversation. It never copies or relocates provider authentication state.

Connector events are bounded to the latest 200 events in
`~/.shellx/outside-connector-events.jsonl`. Simulation routes exercise
allowlist, enabled-state, and target decisions without sending to the target
ShellX session.

When shellX is running, enabled Telegram connectors poll Bot API
`getUpdates` and persist per-connector offsets in
`~/.shellx/outside-connector-runtime.json`. Enabled Discord connectors
connect to Discord Gateway API v10 with the direct-message intent and
record DM `MESSAGE_CREATE` dispatches. Both live paths reuse the same
allowlist, enabled-state, and target decisions as the simulation route;
they record inbox/rejected events and do not send to a ShellX session unless
the connector is configured for session chat. Live auto-prompt work is
limited to 16 active connector dispatches across the app. Only one outside
connector prompt may own a target tab at a time; overlapping messages fail
closed, receive an explicit busy response, and produce an error event rather
than interleaving two agent replies.

---

## 10. GitHub

All GitHub endpoints check `gh auth status` first; on failure they
return `409 conflict` with `error.code: "gh_unauthenticated"` and
`error.data.connectUrl` pointing to the OAuth start URL.

### 10.1 `GET /github/state` *(roadmap, not wired; use `GET /state/github`)*

Detailed state — branch, ahead/behind, remote URL, PRs, issues, rate
limit. Cached server-side for 15 seconds to spare the `gh` rate limit.

### 10.2 `POST /github/pr/create`

```ts
{
  base: string;
  head?: string;                  // defaults to current branch
  title: string;
  body: string;
  draft?: boolean;
  attachTranscript?: boolean;     // appendix from session log
  tabId?: string;                 // sessionId alias also accepted
  confirmRemoteCreate: true;      // explicit per-operation approval
  idempotencyKey?: string;
  releaseTestBoundary?: "stop-before-remote"; // isolated release instances only
}
```

**Response 200:** `{ ok, url, output }` from `gh pr create`.
**Error 428 `approval_required`:** missing `confirmRemoteCreate: true`.
**Error 412 `release_test_remote_mutation_blocked`:** the fixed isolated
`releaseTestBoundary` validated non-empty base/title and stopped before session
lookup, `gh` resolution, subprocess creation, or GitHub contact. Normal app
instances reject this field with `404 release_test_route_unavailable`.
**Non-idempotent** without `idempotencyKey`.

### 10.3 `GET /github/issues/:id` *(roadmap, not wired)*

Fetch one issue with body, labels, comments. Cached 30s.

### 10.4 `POST /github/pr/:n/preview` *(roadmap, not wired)*

Open the PR's diff in the right Preview pane. Equivalent to
`POST /preview { kind: "diff", ... }` but takes the PR number directly.

---

## 11. Files

### 11.1 `GET /files?path=<rel>` *(roadmap, not wired; see §3.8)*

Tree snapshot. Already covered under state.

### 11.2 `POST /files/open` *(roadmap, not wired)*

```ts
{ path: string; sessionId?: string }
```

Resolves path inside session cwd, opens in Preview, returns
`{ kind, path }`.

### 11.3 `POST /files/diff` *(roadmap, not wired)*

```ts
{ path: string; base?: string }   // base = ref to compare to, default HEAD
```

**Response 200:** `{ unified: string, hunks: Array<{...}> }`.

---

## 12. Native host tools

These mirror the `host_mcp` tool surface so an external driver can
exercise the same primitives the active agent uses. They live under
`/tools/<name>` to flag they are host-level, not session-level.

### 12.1 `POST /tools/fs_watch`

```ts
{ path: string; recursive?: boolean; debounceMs?: number }
```

**Response 200:** `{ watchId: string; alreadyWatching: boolean }`. Watcher events arrive on the
`/events` WS with `kind: "fs-watch"`, `payload: { watchId, path, kind:
"created"|"modified"|"deleted", tMs }`.

A separate `DELETE /tools/fs_watch/:watchId` stops the watcher. Watchers
are deduplicated by canonical path, capped at 64 active registrations, and
scoped to the active session's cwd; paths escaping cwd return `403 forbidden`.
`debounceMs` must be between 50 and 60,000.

### 12.2 `POST /tools/process_list`

Returns every tracked process from `process_registry.rs`:

```ts
{
  processes: Array<{
    taskId: string;
    pid: number;
    source: "terminal" | "host_tool" | "debug_api";
    status: "running" | "exited" | "killed" | "failed";
    command: string;
    startedAtMs: number;
    exitedAtMs?: number;
    exitCode?: number;
    cpuPct?: number;
    rssBytes?: number;
  }>;
}
```

**Idempotent:** yes.

### 12.3 `POST /tools/process_signal`

```ts
{
  taskId: string;
  signal:
    | "TERM" | "SIGTERM"
    | "KILL" | "SIGKILL"
    | "INT" | "SIGINT"
    | "HUP" | "SIGHUP"
    | "USR1" | "SIGUSR1";
}
```

Refuses to signal PIDs not in the registry — the safety boundary the
registry exists to provide. Windows accepts `TERM`/`SIGTERM` and
`KILL`/`SIGKILL` only, mapped through `taskkill /T /F`.

### 12.4 `POST /tools/process_stats`

```ts
{ taskId: string }
```

Returns one row from `process_list` plus richer fields (threads, fds,
open files count if available).

### 12.5 `POST /tools/process_attach_stdout`

```ts
{ taskId: string; tailLines?: number }
```

**Response 200:** `{ attachId: string, tail: ProcessLine[] }`. Live
lines arrive on `/events` WS with `kind: "process-line"`,
`payload: { attachId, taskId, stream: "stdout"|"stderr", text, tMs }`.

`DELETE /tools/process_attach_stdout/:attachId` to detach.

### 12.6 `POST /tools/secret_get`

```ts
{ path: string }              // e.g. "vault:providers/openai/api-key"
```

**Vault raw reveal response 403:** `{ code: "RAW_SECRET_REVEAL_DENIED",
message, isError: true }` for `vault:<key>` references. Agents should discover
Vault entries through `vault_list` and use ShellX's mediated fill/injection
flows instead of asking this endpoint to return plaintext.

**Legacy pass-store response 403:** `{ code: "LEGACY_PASS_REVEAL_DENIED",
message, isError: true }` for `pass:<path>` and bare legacy references. Import
or re-enter the secret into ShellX Vault, then request a mediated grant.

**Logging:** request body logs as `{ path: "<redacted>" }`. Response
body **never includes plaintext**. The path itself is treated as sensitive
because it leaks intent.

ShellX does not currently write a dedicated `~/.shellx/audit.log` for this
route. The mediated Vault paths return receipts; operators should not treat
ordinary process diagnostics as an append-only security audit trail.

**Auth gate:** this endpoint is loopback-only and bearer-token protected
like every non-health debug API route. Agents should call it through the
host MCP `secret_get` tool rather than constructing raw HTTP requests.

---

## 13. Terminal

A first-class PTY-backed terminal channel for the bottom-pane Terminal
tab. Distinct from the agent's `run_terminal_command` tool — these are
**user-driven** terminals owned by the UI.

### 13.1 `POST /terminal/spawn` *(roadmap, not wired)*

```ts
{
  cwd?: string;                  // default = active session cwd
  shell?: string;                // default = $SHELL or /bin/bash
  env?: Record<string, string>;
  cols?: number;                 // default 120
  rows?: number;                 // default 30
  idempotencyKey?: string;
}
```

**Response 201:** `{ terminalId: string }`. Internally registered in
`process_registry` with `source: "debug_api"`.

### 13.2 `POST /terminal/:id/write` *(roadmap, not wired)*

```ts
{ bytes: string }     // base64-encoded raw bytes; binary supported
```

**Response 204:** empty.

### 13.3 `GET /terminal/:id` *(roadmap, not wired WS)*

WebSocket upgrade. Server sends frames `{ stream: "stdout"|"stderr",
bytes: base64 }`. Client may send `{ kind: "resize", cols, rows }` or
`{ kind: "write", bytes }` (alternative to the HTTP write endpoint, for
latency-sensitive flows).

**Closing the WS does NOT kill the terminal** — the PTY persists. To
kill, call `POST /tools/process_signal` with the terminal's taskId, or
the convenience `DELETE /terminal/:id`.

---

## 14. Events firehose

### 14.1 `GET /events/recent`

Query parameters are additive and AND-combined:

| Param | Type | Meaning |
| --- | --- | --- |
| `limit` | number | Default 1000, capped at the 8192-event ring capacity. Applied after filters. |
| `since` / `sinceMs` | number (unix ms) | Only events with `t > since`. |
| `tabId` | string | Matches `payload._meta.tabId`, Grok `payload.params._meta.tabId`, or provider `payload.tabId`. `tab` and `sessionId` are accepted aliases. |
| `envelope` | `0` or `1` | `1` returns `{ events, count, earliestT, latestT }`; the default returns the event array. |

Filters are applied to the **ring buffer in memory** — no replay across
restarts. For durable replay, see §17 (session-jsonl pickup).

### 14.2 `GET /events` *(WebSocket)*

Browser WebSocket clients that cannot set an `Authorization` header may pass
the bearer as the percent-decoded `token` query parameter. Keep that URL out
of shell history, screenshots, and request logs; non-browser clients should
prefer the bearer header.

After bearer-token authentication, the socket sends the most recent 200 global
events and then streams all live events. It does not currently apply the
`/events/recent` query filters; single-tab clients should filter live frames by
their tab metadata and use `/events/recent?tabId=...` for bounded rehydration.
Client messages are ignored. A lagging receiver gets
`{ "kind":"debug-api", "payload": { "warning":"lagged" } }` and then
continues from the latest available live frame.

---

## 15. Plan mode roadmap

The wired plan surface today is `POST /plan`, used to save or update a
plan document from a driver. The accept/reject/edit routes below are
roadmap notes, not shipped endpoints. `/build/*` is the shipped
long-horizon approval and receipt surface.

`POST /plan` requires an existing connected tab with an active working
directory. An optional `savePath` may select a `plan.md` below that working
directory, but it cannot create a session or authorize a path outside the
connected project.

### 15.1 `GET /plan?sessionId=<id>` *(roadmap, not wired)*

```ts
{
  active: boolean;
  steps: Array<{
    index: number;
    text: string;
    status: "idle" | "running" | "done" | "blocked" | "rejected";
    notes?: string;
  }>;
  proposedAtMs: number | null;
}
```

`active: false` returns `steps: []`. Always `200`, never `404` —
plan-absent is the default.

### 15.2 `POST /plan/accept` / `POST /plan/reject` *(roadmap, not wired)*

```ts
{ sessionId?: string; steps?: number[] }   // omit = all steps
```

`accept` unlocks the agent to execute the steps. `reject` cancels the
plan and clears state.

### 15.3 `POST /plan/edit` *(roadmap, not wired)*

```ts
{ sessionId?: string; step: number; text: string }
```

Updates one step's text. Allowed only before any step has run
(`status == "idle"` across all of them) — otherwise `409 conflict`.

---

## 16. Authentication

### 16.1 Today (v1.x) — Bearer auth required

**Loopback-only + Bearer auth.** The server binds to `127.0.0.1` on a
port chosen at startup (default `5757`, fallbacks `5759`/`5761`/
`5763`/`5765`; the live value is in `~/.shellx/debug-api.port`) and
**must** reject any request whose `Origin` or `Host` indicates a
non-loopback client. Loopback-only binding is necessary but not
sufficient — a malicious local user on the same machine can still
reach the port, which is why every request also needs a bearer token.

**Bearer auth is required on every endpoint except `/health`.** ShellX-owned
clients resolve the per-user credential internally. Custom clients must receive
it through a private process-local integration and pass it as:

```
Authorization: Bearer <token>
```

Mismatch returns `401 unauthorized`. The WS upgrade reads the token from a
query param `?token=<>` because browsers do not support custom headers on WS.

Server-side authentication accepts a process-local override for isolated CI
and otherwise creates one per-user credential. The generated credential is 32
hex characters and is stored with mode `0600` on macOS/Linux or the inherited
user-private profile ACL on Windows. Client code should not depend on that
storage implementation.

ShellX also writes a private local descriptor with the bound
`url`, `browserAction`, `browserCheck`, `browserSummary`, `browserSettle`, `browserState`, `browserTabs`, `events`,
and `health` endpoints for local tool discovery. For ordinary installs the
private on-disk copy may include the bearer for ShellX-owned local clients;
process-local overrides are never persisted there. The descriptor intentionally advertises
`rawCdpExposed: false`; Browser automation must continue through the
gated `/browser/*` Debug API routes.

Authenticated clients can also fetch the live descriptor from
`GET /shellxagent.json` or `GET /.well-known/shellxagent.json`. This served
copy omits the token field value and exposes only non-secret discovery
metadata.

Agent-facing documentation is bundled into the desktop binary and exposed in
two product-owned ways on every fresh install. It is not installed into global
Grok, Codex, or Claude skill discovery, so direct CLI sessions stay unchanged:

- On disk: `~/.shellx/agent-docs/shellx-host/SKILL.md`.
- Over the authenticated Debug API: `GET /agent-doc/manifest` and
  `GET /agent-doc/skills/shellx-host/SKILL.md`.

ShellX-launched Grok processes receive a compact `--rules` value plus a
session-scoped ACP host MCP entry. WSL and SSH launches remove legacy
ShellX-owned project registrations and do not write replacements. Upgrades
remove only the exact legacy global ShellX skill leaves and ShellX-marked
blocks from Grok configuration and `AGENTS.md`, preserving unrelated user
content.

`/health` is the only endpoint exempt from auth — it's the liveness
probe used by drivers waiting for the app to come up.

The host MCP HTTP server (separate port, published to
`~/.shellx/mcp-http.port`) uses an independently generated private per-user
credential. Rotate the Debug API and Host MCP credentials independently.

---

## 17. Diagnostics and audit boundary

ShellX does not currently implement the previously proposed per-request
Debug API log schema or a dedicated `~/.shellx/audit.log`. Do not rely on
process stdout/stderr as a complete, append-only record of authenticated API
activity.

Product surfaces that promise evidence use their own bounded receipts and
artifacts, including Browser actions, Flight Recorder exports, Vault grants,
build/goal receipts, and release-driver evidence. Request logging with a
documented redaction schema, caller identity, retention policy, and rotation
contract remains roadmap work and is not part of the current API.

---

## 18. Driver coverage

Driver coverage is generated rather than maintained as a prose checklist:

- `release/surface-inventory.json` is the authoritative route/tool/command/UI
  inventory.
- `release/surface-driver-plan.json` maps every surface and platform to an
  owned driver family and records any explicit `building` backlog.
- `pnpm surface:inventory:check` and `pnpm surface:driver-plan:check` reject
  source drift.
- `pnpm release:surface-run-drivers -- ...` runs the frozen installed-candidate
  assignments. Native keyboard, palette, drag/drop, and OS picker assignments
  use WebDriver/native input; Debug API assignments use the authenticated
  loopback surface.
- `pnpm release:surface-compose` and `pnpm release:surface-verify` bind the
  driver results to the exact candidate, platform, signature, and installation
  receipts.

The final signed-candidate gate is intentionally run once against the frozen
release candidate immediately before publication, not after every development
edit. A green source test suite is not a substitute for that installed proof.

---

## 19. Evolution rules

1. **Never delete an endpoint.** Deprecate via a `Deprecation: true`
   response header and a `Sunset: <date>` header. Keep responding for
   at least one minor version after deprecation.
2. **Never repurpose a field.** If `payload.foo` meant one thing in
   v1.3, it means that exact thing in v1.99.
3. **Never tighten validation in a minor version.** Loosening (accept
   more shapes) is fine; rejecting previously-accepted input is a
   major bump.
4. **Always update `GET /` in the same commit** that adds a new
   endpoint. The discovery index is part of the contract.
5. **Always add a driver test in the same commit** for an endpoint
   the UI checklist marks as wired. `[W]` and `[A]` must move
   together; `[T]` follows in the next driver pass.
6. **Idempotency keys are forever.** Once an endpoint accepts
   `idempotencyKey`, it accepts it forever. Removing the field is a
   major bump.

---

## 20. Open questions (non-blocking)

These are flagged for resolution before the relevant implementation
phase, not before merging this spec.

- **Streaming vs polling for `GET /state/*`:** the spec assumes polling
  is cheap (≤10 Hz). If profiling shows >5% CPU at idle, introduce
  optional `GET /state/*` WS variants that push deltas. Defer until
  measured.
- **WS multiplexing:** today every consumer opens a fresh `/events`
  WS. At 5+ concurrent subscribers we'll want a single shared WS with
  client-side fan-out. Decision deferred to the v1.2 milestone.
- **Auth UX for browser drivers:** if a future web-based driver runs
  outside Tauri, browsers cannot easily set `Authorization` headers
  for WS. The §16.2 fallback (query-param token) covers this but the
  security review is pending.
- **Quota / rate-limit:** none in v1. If `/state/*` polling abuses the
  surface, add token-bucket per-IP. Likely not needed while loopback-
  only.

---

**Length:** ~3,200 words. Future revisions should keep individual
section bodies short; the spec is meant to be skimmable by a fresh
implementer in under 20 minutes.
