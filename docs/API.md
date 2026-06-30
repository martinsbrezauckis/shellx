# shellX — Agent-First Protocol (HTTP + WS Surface on `127.0.0.1:<bound-port>`)

> The shellXagent HTTP+WS server binds to `127.0.0.1` on a port chosen at
> startup. The preferred port is `5757` (overridable via
> `SHELLX_DEBUG_PORT`; legacy `GROK_SHELL_DEBUG_PORT` also works); when busy the server steps up to
> `5759`/`5761`/`5763`/`5765`. The **actually-bound** port is written
> atomically to `~/.shellx/debug-api.port` — external drivers must read
> that file rather than hard-coding `:5757`. The host MCP HTTP server
> publishes its port to `~/.shellx/mcp-http.port` the same way.

**Status:** Implementation guide plus v1.x roadmap (drafted 2026-05-17,
current route inventory refreshed 2026-06-30).
**Audience:** Any future implementer (human or agent) extending shellX's
debug API beyond what is already wired in `src-tauri/src/debug_api.rs` and the
`src-tauri/src/debug_api_browser*.rs` route handlers.
**Goal:** Make every UI surface driveable without a GUI, so the
agent-first verification loop (`pnpm drive`) can prove
behavior end-to-end.

The wired route table in `src-tauri/src/debug_api.rs` is the source of truth
for what clients can call today; Browser handler behavior is split through
`debug_api_browser*.rs` modules. Sections below that describe routes not listed
in the current implementation inventory are roadmap targets, not shipped
endpoints. Breaking changes to wired routes require bumping `X-API-Version`
major and shipping a migration shim.

## Current Implementation Inventory

These routes are wired today. All routes except `GET /health` require the
debug bearer token from `~/.shellx/shellxagent.token` or
`SHELLX_DEBUG_SECRET` (legacy `GROK_SHELL_DEBUG_SECRET` also works).
On launch ShellX also writes `~/.shellx/shellxagent.json`, a private
discovery descriptor containing the bound Debug API URL, existing bearer
token when file-based auth is active, and gated Browser route paths. The
same descriptor is available to authenticated local clients at
`GET /shellxagent.json`. Installer-bundled agent docs are available at
`GET /agent-doc/manifest` and
`GET /agent-doc/skills/shellx-host/SKILL.md`. None of these surfaces
expose raw CDP.

| Method | Path |
| --- | --- |
| GET | `/health`, `/shellxagent.json`, `/.well-known/shellxagent.json`, `/agent-doc`, `/agent-doc/manifest`, `/agent-doc/skills/shellx-host/SKILL.md`, `/agent-doc/shellx-host/SKILL.md`, `/events/recent`, `/events`, `/state/header`, `/state/footer`, `/state/subagents`, `/state/ui`, `/state/files`, `/state/skills`, `/state/github`, `/state/github/items`, `/state/sessions`, `/state/tabs/report`, `/state/agent_runs`, `/state/session_assets`, `/state/marketplace_health`, `/state/session_tooling`, `/state/environment`, `/state/grok_environment`, `/state/session_activity`, `/state/session_git`, `/state/session_git/diff`, `/state/model_instruction_cards`, `/state/agent_cli_setup`, `/panels`, `/preview`, `/preview/work/state`, `/preview/work/logs`, `/preview/work/diagnose`, `/screenshot`, `/settings`, `/sessions/history`, `/sessions/search`, `/sessions/history/:id`, `/sessions/:id/snippet`, `/goal/state`, `/build/state`, `/build/receipts`, `/provider-adapters/state`, `/provider-sessions/state`, `/vault/status`, `/vault/grants`, `/vault/keys`, `/vault/resources`, `/connections`, `/outside-connectors`, `/outside-connectors/capabilities`, `/outside-connectors/events`, `/browser/state`, `/browser/tabs`, `/browser/profiles`, `/browser/tasks`, `/browser/bookmarks`, `/browser/receipts`, `/browser/privacy`, `/browser/personal-lock`, `/browser/shields`, `/browser/developer-mode`, `/browser/downloads`, `/browser/uploads`, `/browser/logs`, `/browser/storage-state`, `/browser/dialogs`, `/browser/permissions`, `/browser/popups`, `/browser/network`, `/browser/robots` |
| POST | `/connect`, `/prompt`, `/abort`, `/disconnect`, `/autonomy`, `/state/ui`, `/panels`, `/preview`, `/preview/work/start`, `/preview/work/stop`, `/preview/work/restart`, `/preview/work/diagnose`, `/state/environment/trace_export`, `/state/grok_environment/trace_export`, `/state/session_git/checkpoint`, `/state/session_git/worktree`, `/tools/fs_watch`, `/tools/process_list`, `/tools/process_signal`, `/tools/process_stats`, `/tools/process_attach_stdout`, `/tools/secret_get`, `/settings`, `/sessions/:id/archive`, `/tabs/:id/archive`, `/plan`, `/goal/start`, `/goal/stop`, `/goal/complete`, `/goal/pause`, `/goal/resume`, `/goal/approve`, `/goal/reject`, `/build/start`, `/build/stop`, `/build/complete`, `/build/receipt`, `/build/pause`, `/build/resume`, `/build/recheck_blocker`, `/build/operator_note`, `/build/approve`, `/build/reject`, `/permissions/:reqId/respond`, `/provider-adapters/run`, `/provider-sessions/start`, `/provider-sessions/abort`, `/agent_cli_setup/install/prepare`, `/agent_cli_setup/install/confirm`, `/agent_cli_setup/recheck`, `/diagnostics`, `/github/pr/create`, `/vault/lock`, `/vault/setup/begin`, `/vault/setup/confirm-recovery`, `/vault/remember-device`, `/vault/grants`, `/vault/grants/:grant_id/revoke`, `/vault/get`, `/vault/set`, `/vault/delete`, `/connections`, `/connections/provider-scan`, `/connections/:id/test`, `/outside-connectors`, `/outside-connectors/:id/test`, `/outside-connectors/:id/simulate`, `/browser/open`, `/browser/tabs/open`, `/browser/tabs/focus`, `/browser/tabs/reorder`, `/browser/tabs/close`, `/browser/tabs/lock`, `/browser/tabs/heartbeat`, `/browser/tabs/unlock`, `/browser/task/start`, `/browser/task/autonomy`, `/browser/task/control`, `/browser/task/finish`, `/browser/action`, `/browser/logs`, `/browser/downloads/request`, `/browser/downloads/complete`, `/browser/uploads/request`, `/browser/uploads/complete`, `/browser/cdp/execute`, `/browser/trace/export`, `/browser/har/export`, `/browser/performance/export`, `/browser/recipes/export`, `/browser/recipes/replay`, `/browser/robots/schedule`, `/browser/robots/run`, `/browser/robots/cancel`, `/browser/storage-state/export`, `/browser/dialogs`, `/browser/dialogs/resolve`, `/browser/permissions`, `/browser/permissions/resolve`, `/browser/popups`, `/browser/session-grants/request`, `/browser/session-grants/resolve`, `/browser/session-grants/apply`, `/browser/vault-deposits`, `/browser/vault/fill-receipt`, `/browser/vault/generate-receipt`, `/browser/report` |
| DELETE | `/connections/:id`, `/outside-connectors/:id`, `/browser/bookmarks/:bookmark_id`, `/browser/shields/site/:host` |

Legacy `/goal/*` endpoints remain wired for old automation, but new
long-horizon automation should use `/build/*` and public UI should present
`/build` as the single command.

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
| POST | `/vault/grants` | Creates a pending scoped grant for mediated use. The request appears in the ShellX Vault Request Center; approval is in-app/Tauri-only and agents cannot self-approve. |
| POST | `/vault/grants/{grantId}/revoke` | Revokes a grant. |
| GET | `/vault/keys` | Lists agent-visible key names plus descriptions in `entries`; secret values are never returned and user-only entries are hidden. |
| GET | `/vault/resources` | Lists agent-visible typed resources in `resources` and `entries`: `secret`, `profileCard`, compatibility `emailInbox`, and `stripeAgentWallet`. Values are never returned; user-only resources are hidden. |
| POST | `/vault/set` | E2E/operator-test only over Debug API (`SHELLX_VAULT_E2E=1` plus disposable `SHELLX_VAULT_PROFILE_DIR`). Stores a value and optional non-secret metadata without echoing the value. User writes use the ShellX UI/Tauri command path. |
| POST | `/vault/get` | Raw reveal is denied on the Debug API and returns `raw_secret_reveal_denied`; use mediated fill/injection routes instead. |
| Tauri | `shellx_vault_lock` | Operator/UI-only manual lock. Clears the active Vault session and local plaintext compatibility cache; remembered-device unlock remains configured but will not auto-unlock until the user enters the master passphrase again. |
| Tauri | `shellx_vault_unlock` | Operator/UI-only passphrase unlock. Re-enables normal remembered-device behavior after a manual lock. |

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
  "actorScope": { "kind": "allShellxAgents" },
  "expiresAtMs": 1790000000000
}
```

Supported mediated operations are `fill`, `profileFill`, `emailCodeRead`,
`agentWalletUse`, `injectEnv`, `providerUse`, `connectorUse`, and `deposit`.
`rawReveal` is not part of the agent-facing flow. Pending grants return
`approved: false`; agent use remains denied with `grantPending` until the
operator approves the request in the Vault Request Center.

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

Host MCP exposes thin Browser wrappers named `browser_state`, `browser_tabs`,
`browser_locks`, `browser_navigate`, `browser_observe`, `browser_click_ref`,
`browser_click_at`, `browser_fill_ref`, `browser_type_text`,
`browser_clear_site_data`, `browser_fill_from_vault`, `browser_wait_for`,
`browser_extract`, `browser_save_page`, `browser_verify`, `browser_screenshot`,
`browser_downloads`, `browser_resolve_dialog`, and `browser_trace_open`. Agents should
treat this as the native ShellX Browser web surface: get tabs/state, navigate
with `browser_navigate`, observe refs, act on refs, use
`browser_fill_from_vault` for grant-approved credential fills, resolve
task-owned beforeunload prompts with `browser_resolve_dialog`, then verify,
capture page evidence, or export a redacted trace. When API keys, generated
passwords, or tokens are visible on a page, `browser_observe` may return
redacted `secret-*` refs; agents should pass those refs to
`browser_capture_secret_to_vault` with a durable Vault ref instead of reading
clipboard/raw values. For rich editors or canvas surfaces that have no usable
DOM ref, agents can use `browser_screenshot` to choose viewport CSS coordinates
and then `browser_click_at` / `browser_type_text`; normal inputs should still
use refs. If a visible ref click reports applied but a Google-style menu/page
state does not change, retry the same ref with `browser_click_ref force=true`
to dispatch native pointer input. For split buttons/dropdowns where the whole
button ref still does not change state, use full-page screenshot evidence and
coordinate-click the visible arrow/subtarget. For coordinate work, prefer
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
Page-mutating Browser MCP calls and trace exports remain write-class host tools
and require the same ShellX MCP write gate as other host mutations.
Agents should not dump raw `/browser/state` or `browser_observe` JSON into
the current working directory, Downloads, or other user folders for evidence.
Use `browser_trace_open` for bounded redacted diagnostics and
`browser_save_page` only for user-requested page content.

Read routes:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/browser/state` | Profiles, bookmarks, history, tasks, personal lock state, native engine state, grants, deposits, console logs, receipts, and window state. |
| GET | `/browser/tabs` | Browser tabs with active tab, profile, task binding, user/agent/delegated owner state, lock state, storage root, and privacy mode. |
| GET | `/browser/profiles` | Small owned profile set: `personal`, `agent-work`, `task-disposable`. |
| GET | `/browser/tasks` | Browser task snapshots. |
| GET | `/browser/bookmarks` | Bookmark tree plus toolbar view; links and folders only, no page storage values. |
| GET | `/browser/receipts?limit=200` | Most recent browser receipts. |
| GET | `/browser/privacy` | Current global/profile ad mode settings and low-entropy identity policy. |
| GET | `/browser/personal-lock` | Current Personal Browser Lock state: enabled flag, timeout, auth mode, locked flag, and redacted PIN-configured flag. Mutations are operator/Tauri-only. |
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
| POST | `/browser/task/start` | `{ goal, startUrl?, profileId?, autonomy?, expectedDomains?, blockedDomains? }` |
| POST | `/browser/task/autonomy` | `{ taskId?, autonomy }` |
| POST | `/browser/task/control` | `{ taskId?, action:"pause"|"resume"|"abort"|"userTakeover", reason?, requestedBy? }` |
| POST | `/browser/task/finish` | `{ taskId?, status? }` |
| POST | `/browser/action` | `{ browserTabId?, taskId?, action, url?, selector?, refId?, value?, key?, grantId?, secretRef?, sensitiveKind?, approvalId?, lockLeaseId?, ownerAgentId?, ownerRunId?, fullPage? }` |
| POST | `/browser/bookmarks` | `{ bookmarkId?, label, kind?, parentId?, url?, category?, toolbarPinned?, toolbarOrder?, agentWorkflow? }`; `kind` is `link` or `folder`. `agentWorkflow` is experimental metadata for reusable agent workflow bookmarks. |
| POST | `/browser/bookmarks/reorder` | `{ items: [{ bookmarkId, parentId?, toolbarPinned?, toolbarOrder? }] }`; rejects folder cycles. |
| DELETE | `/browser/bookmarks/:bookmark_id` | Delete a bookmark; deleting a folder also removes its children. |
| POST | `/browser/logs` | `{ taskId?, level, source?, message, url?, line?, column?, details? }` |
| Tauri | `shellx_browser_update_privacy` | Operator/UI-only `{ request: { globalAdMode?, profileId?, profileAdMode? } }`, where user-facing modes are `off`, `balanced`, and `strict`. Debug API `POST /browser/privacy` is forbidden with `browser_privacy_requires_operator`. |
| Tauri | `shellx_browser_update_personal_lock` | Operator/UI-only `{ request: { enabled?, timeoutMinutes?, authMode?, blurLockedTabs?, pauseDelegatedTabsWhenLocked?, action?, pin?, newPin?, trustedUserActivity? } }`. Debug API `POST /browser/personal-lock` is forbidden with `browser_personal_lock_requires_operator`. |
| Tauri | `shellx_browser_delegate_tab_to_agent` | Operator/UI-only `{ request: { browserTabId, taskId, grantId?, reason? } }`; hands a user-owned tab to a Browser task without creating a Vault grant. |
| Tauri | `shellx_browser_take_back_tab_from_agent` | Operator/UI-only `{ request: { browserTabId, reason? } }`; returns a delegated tab to personal user control without revealing Vault secrets. |
| Tauri | `shellx_browser_update_shields` | Operator/UI-only `{ request: { enabled?, adTrackerMode?, cookieMode?, fingerprintingMode?, httpsUpgradeEnabled?, scriptBlockingEnabled? } }` for global Shields defaults. Debug API `POST /browser/shields` is forbidden with `browser_shields_requires_operator`. |
| Tauri | `shellx_browser_update_site_shields` | Operator/UI-only `{ request: { host, adTrackerMode?, cookieMode?, fingerprintingMode?, httpsUpgradeEnabled?, scriptBlockingEnabled? } }` for one host override. Debug API `POST /browser/shields/site` is forbidden with `browser_shields_requires_operator`. |
| Tauri | `shellx_browser_remove_site_shields` | Operator/UI-only `{ request: { host } }` to remove one host override. Debug API `DELETE /browser/shields/site/:host` is forbidden with `browser_shields_requires_operator`. |
| GET | `/browser/developer-mode` | Read current Browser Developer Mode policy, full-CDP flag, and approved hosts. |
| Tauri | `shellx_browser_update_developer_mode` | Operator/UI-only `{ request: { enabled?, fullCdpAccess?, policyDisabled?, approvedHosts? } }`. Debug API `POST /browser/developer-mode` is forbidden with `developer_mode_requires_operator`. |
| Tauri | `shellx_browser_approve_developer_mode_host` | Operator/UI-only `{ request: { host?, currentUrl?, taskId?, fullCdpAccess? } }`. Debug API `POST /browser/developer-mode/approval` is forbidden with `developer_mode_requires_operator`. |
| POST | `/browser/downloads/request` | `{ taskId?, browserTabId?, url, fileName?, destinationDir?, reason }` |
| POST | `/browser/downloads/complete` | `{ transferId, finalPath, mimeType?, bytes, sha256, sourceUrl?, destination?, retentionReason, approvalId }` |
| POST | `/browser/uploads/request` | `{ taskId?, browserTabId?, filePath, displayName?, destinationOrigin?, refId?, reason }` |
| POST | `/browser/uploads/complete` | `{ transferId, finalPath?, mimeType?, bytes, sha256, sourceUrl?, destination?, retentionReason, approvalId }` |
| Tauri | `shellx_browser_grant_transfer` | Operator/UI-only `{ request: { transferId, direction, origin?, sha256?, ttlSeconds? } }`; mints the approval token required by transfer completion. |
| POST | `/browser/cdp/execute` | `{ taskId?, browserTabId?, method, params?, expression?, reason? }`; requires Developer Mode full CDP approval for the active host. |
| POST | `/browser/trace/export` | `{ taskId?, browserTabId?, reason? }` |
| POST | `/browser/har/export` | `{ taskId?, browserTabId?, reason? }`; writes a redacted HAR artifact without headers, bodies, cookies, query strings, or fragments. |
| POST | `/browser/performance/export` | `{ taskId?, browserTabId?, reason? }`; writes sanitized navigation/resource timing metrics. |
| POST | `/browser/recipes/export` | `{ taskId?, browserTabId?, reason? }`; converts recent receipts into a redacted replay recipe. |
| POST | `/browser/recipes/replay` | `{ taskId?, browserTabId?, recipePath?, recipe?, dryRun?, reason? }`; dry-runs by default, or applies saved navigation/click/wait/select/press/verify route steps when `dryRun:false`; redacted, live-bound, or unsupported steps are skipped with reasons. |
| POST | `/browser/robots/schedule` | `{ taskId?, browserTabId?, recipePath?, runAtMs?, kind?, reason }` |
| POST | `/browser/robots/run` | `{ jobId, dryRun? }` |
| POST | `/browser/robots/cancel` | `{ jobId, reason? }` |
| POST | `/browser/storage-state/export` | `{ profileId?, reason? }` |
| Tauri | `shellx_browser_clear_history` | Operator/UI-only local history clearing. Agent `clearHistory` stays blocked with `destructiveActionApproval`; registry mutation without the operator path returns `browser_destructive_action_requires_operator`. |
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
| POST | `/browser/session-grants/apply` | `{ grantId, taskId? }`; only succeeds after a host-approved grant. |
| POST | `/browser/vault-deposits` | `{ taskId?, label, secretValue, sourceUrl? }`; writes to Vault first, then returns a redacted receipt with `vaultRef`, `storageCommitHash`, and `secretExposed:false`. |
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
authorizes `AgentWalletUse` on a `stripeAgentWallet` resource and records
redacted checkout-preparation metadata; ShellX does not store generic user
payment cards.

Browser tabs are first-class control objects. A locked tab rejects observation,
navigation, and DOM mutation unless the request includes the matching
`lockLeaseId`, `ownerAgentId`, and `ownerRunId`. Denied actions return
`status:"tabLocked"` with a `browserTabLockDenied` receipt and do not touch the
page. The Debug API does not expose operator force-unlock; callers must own the
lease or wait for expiration.

Browser tasks also have operator controls. `POST /browser/task/control` can
pause, resume, abort, or hand a task to the user with a receipt-backed status
change. While a task is `paused`, `aborted`, or `userTakeover`, `/browser/action`
returns a blocked response such as `status:"taskPaused"` plus a
`browserTaskActionBlocked` receipt before it reaches the native WebView path.
This keeps human takeover and stop/pause decisions authoritative even for
engine-backed actions.

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

Browser observations are compact and task-facing. Alongside bounded
`text`/`markdown`, `snapshotId`, and selector-backed `refs`, `observe` returns:

- `domSummary`: counts for links, buttons, inputs, forms, tables, headings, and
  observed text bytes;
- `formFields`: bounded form/control metadata with label, selector, field kind,
  required/disabled state, autocomplete, form action, and redacted password
  values;
- `accessibilityTree`: a bounded accessibility-style control summary, including
  synthetic `page`, `address`, and `report` nodes so external agents can target
  stable Browser actions consistently.

Selector-backed refs also include agent reliability metadata: `name`, `testId`,
`locatorSuggestions` for role/name, label, placeholder, text, test id, CSS, and
XPath where available, `bounds`, `visible`, `enabled`, `editable`, `frameId`,
and `strictMatchCount`. Engine-backed actions return `actionability` evidence
for attached, visible, stable, enabled/editable, in-viewport, receives-events,
and strict-match checks; failed checks return `notActionable` instead of a fake
success. Covered click targets include `actionability.coveringElement` so an
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
`~/.grok/shellx-browser-screenshots/`, and returns a `screenshot` artifact with
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
query strings and fragments from the task text, and starts a Browser task in
the chat panel so agents can explain the page without dumping raw Browser state
or secrets into user folders.
`POST /browser/trace/export` writes a bounded JSON trace bundle under
`~/.grok/shellx-browser-traces/` and returns `traceId`, `path`, `bytes`,
`sha256`, source, and a `browserTraceBundleExported` receipt. The bundle keeps
task/tab/engine state, last-observation metadata, recent receipts, console logs,
transfer intents, privacy settings, and an explicit redaction policy. It does
not retain raw DOM, cookies, local-storage values, network bodies, raw secrets,
or full screenshots. It should be left in ShellX trace storage unless the user
explicitly asks for an exported copy.
`POST /browser/cdp/execute` is the gated CDP-like executor for native WebView
debugging. It requires Browser Developer Mode, full CDP access, and an
approved active host before running bounded methods such as
`Runtime.evaluate`, `Performance.getMetrics`, and `DOM.getDocument`; results
are redacted before they are returned or stored in receipts. Debug API callers
cannot enable Developer Mode, disable it, reset approved hosts, or approve
hosts; that authority belongs to the ShellX operator/UI Tauri path.
`POST /browser/har/export` and `POST /browser/performance/export` write hashed
artifacts under `~/.grok/shellx-browser-har/` and
`~/.grok/shellx-browser-performance/`. HAR exports contain safe request/response
metadata only: no headers, bodies, cookies, query strings, or fragments.
Performance exports sanitize resource URLs before writing timings.
`POST /browser/recipes/export` converts recent receipts into a redacted replay
recipe under `~/.grok/shellx-browser-recipes/`; typed input values become
`valueRef` placeholders so replay must source values from the user or Vault.
Recipe artifacts use Action Recipe V2 fields: `schemaVersion`, workflow `goal`,
redacted `steps`, `variableInputs`, `assertions`, `decisionPoints`,
`sourceReceipts`, and `redactionPolicy`.
`POST /browser/recipes/replay` dry-runs by default. When called with
`dryRun:false`, ShellX converts replayable recipe steps such as navigation,
observe, click/click-ref, wait, scroll, select, press, verify, extract, and
non-redacted find-text into Browser actions and applies them through the same
WebView engine, locks, receipts, and approval gates as normal agent Browser
control. This makes saved workflows real fast tracks for repeated site tasks
while redacted input, live Vault capture/fill, unsupported actions, and failed
applies are returned as `skippedSteps` with stable reasons instead of being
silently replayed. Agents can save repeatable fast-tracks by exporting a
successful task recipe and then upserting a Browser bookmark with
`agentWorkflow` taxonomy (`siteKey`, `taskType`, `target`, `surface`,
`secretKinds`, `recipePath`, and health/drift/contract metadata), so later runs
can discover the workflow before falling back to live navigation.
`/browser/robots/*` manages scheduled recipe/work-queue jobs with auditable
schedule, run, blocked, cancelled, and completed receipts.
`GET /browser/storage-state` and `POST /browser/storage-state/export` expose
safe manifests only: profile id, storage root, cookie/local-storage policy,
retention policy, session grant status, and artifact hash when exported. They
never return cookie values, local-storage values, session-storage values,
headers, or network bodies. `POST /browser/session-grants/request` records an
agent request for profile session reuse. Session grant decisions are
operator-owned: Debug API resolve calls return
`browser_session_grant_resolution_requires_operator`, while the
`shellx_browser_resolve_session_grant` Tauri command applies the operator/UI
decision. `POST /browser/session-grants/apply` records that a
host-approved session profile is available to an agent profile and emits
`browserSessionGrantApplied`; actual cookie/session copying remains reserved
for the later ShellX Vault/session bridge.
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
Native WebView permission requests and limited page-side permission signals are
also recorded automatically and denied at the engine until ShellX applies an
explicit operator decision.
`GET /browser/popups` and `POST /browser/popups` record
popup/new-window requests with query/fragment redacted from visible URLs; they
do not expose a reusable hash of the hidden full target URL.
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
and Grok Imagine video. Agents should invoke the named ShellX handoff tool
immediately after the user names the provider, rather than running raw provider
CLIs or searching provider logs first. ShellX clamps named media handoff
timeouts below `900000` ms so short agent-supplied watchdogs do not kill image
or video generation.

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

## Agent CLI Setup Surface

The setup assistant exposes the same Local/WSL/SSH agent CLI setup flow used
by Connections and the right-rail Agent CLIs card. It is explicit-action only:
reading state and preparing an install never runs a command.

| Method | Path | Body/query |
| --- | --- | --- |
| GET | `/state/agent_cli_setup` | `?connectionId=<conn-id>` optional; omitted means current local |
| POST | `/agent_cli_setup/install/prepare` | `{ connectionId?, preset?, providerId, methodId? }` |
| POST | `/agent_cli_setup/install/confirm` | `{ confirmationId }` |
| POST | `/agent_cli_setup/recheck` | `{ connectionId?, preset? }` |

`providerId` is one of `grok`, `claude-code`, `codex-cli`, or
`antigravity-cli`. `preset` is a full `ConnectionPreset` body and is useful for
debug scripts that are testing an unsaved WSL or SSH target.

`prepare` returns the exact command, shell, provider, target, source URL, and
`requiresConfirmation: true`. The command is stored server-side under the
confirmation id. `confirm` accepts only that id and executes the prepared
command; callers cannot pass or modify a command during confirmation.

---

## Provider Adapter CLI Surface

These endpoints are the first ShellX-native integration layer for
non-Grok coding-agent CLIs. They do not replace the current Grok ACP chat
session. They let an authenticated driver discover and run Codex CLI,
Claude Code, and Antigravity CLI from ShellX's debug API, then receive a
normalized parse result.

| Method | Path | Body/query |
| --- | --- | --- |
| GET | `/provider-adapters/state` | `?transport=local\|wsl\|ssh&wslDistro=<distro>&sshHost=<user@host>&sshPort=<port>&sshKeyVaultRef=<vault-key>` optional |
| POST | `/provider-adapters/run` | `{ providerId, cwd, prompt, includeMcpProbe?, includeShellxTooling?, shellxToolExposure?, mcpPath?, timeoutMs?, persistSession?, resume?, resumeLast?, providerConversationId?, permissionMode?, transport?, wslDistro?, sshHost?, sshPort?, sshKeyVaultRef?, recordEvents? }` |
| GET | `/provider-sessions/state` | `?tabId=<tab>&transport=local\|wsl\|ssh&wslDistro=<distro>&sshHost=<user@host>&sshPort=<port>&sshKeyVaultRef=<vault-key>` optional |
| POST | `/provider-sessions/start` | `{ tabId?, providerId, cwd, prompt, includeMcpProbe?, includeShellxTooling?, shellxToolExposure?, mcpPath?, timeoutMs?, persistSession?, resume?, resumeLast?, providerConversationId?, permissionMode?, transport?, wslDistro?, sshHost?, sshPort?, sshKeyVaultRef? }` |
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
| Antigravity CLI | `agy --dangerously-skip-permissions --add-dir <cwd> --print <prompt>` | final plain text only; tool/shell calls are not visible on stdout |

Provider runs default to `transport: "local"`, which launches provider
binaries on the Windows/local host. For WSL provider CLIs, pass
`transport: "wsl"` and `wslDistro`; ShellX wraps the native provider command
as `wsl.exe -d <distro> --cd <cwd> -e bash -lc '<provider> ...'`. In this
mode `cwd` must be the POSIX WSL project path. For SSH provider CLIs, pass
`transport: "ssh"` and `sshHost` (`user@host`); ShellX launches `ssh -T`,
prepends a remote PATH setup, changes to the remote POSIX `cwd`, and reverse
forwards the ShellX host MCP HTTP port. `sshPort` is optional. `sshKeyVaultRef`
is a non-secret vault key whose value is the local SSH identity-file path;
ShellX resolves it for SSH probes and provider launches and does not expose the
resolved key path in debug API state. Provider session resume ids are scoped by
provider, transport target, and SSH key vault ref, so a local Claude session id
is not reused for `wsl:Ubuntu-24.04`, `ssh:deploy@203.0.113.10`, or another
saved identity on the same SSH endpoint.

Provider sessions default to `persistSession: true`. ShellX does not store
provider transcripts; it records only the provider-native conversation id it
can observe, keyed by tab, provider, and transport in
`~/.shellx/provider-sessions.json`.
Codex ids are read from JSONL `thread_id`/session fields, Claude ids from
stream-json `session_id`/session fields. Current Antigravity print mode does
not expose a structured id, so ShellX can pass an explicit resume id but cannot
infer a new native id from stdout.

Resume policy: ShellX should use provider-native resume wherever the provider
has one. For Codex and Claude this means persisting the native conversation id
per ShellX tab/provider and calling the provider resume surface. For Grok ACP
tabs this means `session/load` with the prior `sessionId`. ShellX should not
build a parallel transcript-memory system for normal provider sessions. The
exception is ShellX-owned `/build`, where the build scratchboard, receipts, and
run gates are injected because they are ShellX state, not provider memory.

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
Antigravity currently ignores MCP probe wiring because `agy --print` has
no structured tool-call stream.

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
provider sessions can call ShellX host tools (`capabilities_summary`,
`search_tool`, `fs_*`, `process_*`, `vision_describe`, `Agent`, receipts, and
related host tooling). These host `fs_*` tools execute on the ShellX parent
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
Write-class MCP tools require the tab-bound token for the claimed tab; the
global MCP token remains accepted for health/read compatibility. For SSH
provider sessions, ShellX uses `ssh -R` so remote `localhost:<mcp-port>`
reaches the local ShellX MCP server. Claude gets a private MCP config written
to the remote host. Codex gets its bearer env staged in a temporary 0600 remote
file that is sourced and removed before provider exec, so the token is not
placed in the SSH command line. Antigravity does not get ShellX MCP tooling
until its CLI exposes MCP configuration for `agy --print`.

`GET /provider-adapters/state` probes local, WSL, and SSH binaries live when
the corresponding transport query is supplied. For SSH targets, include
`sshHost` and optional `sshPort`; saved connection scans are used by the UI as
cached picker hints, but the state endpoint can refresh the target directly.

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
**Driver:** not yet exercised by `pnpm drive`. Add in next driver
revision so the harness sanity-checks surface drift on every run.

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

### 3.1 `GET /health` *(v1.0, exists)*

**Purpose:** Liveness probe.
**Response 200:** `{ ok: true, debugApiPort: 5757 }`.
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
  autonomy: "observe" | "propose" | "confirm" | "auto";
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
  } | null;
  debugHighlights: Array<{
    id?: string;
    selector: string;
    label?: string;
    color?: "blue" | "green" | "red" | "yellow" | "orange" | "cyan" | "magenta" | string;
    index?: number;
    text?: string;
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
  }>;
  uiRevision: number;
  lastUiPatchMs: number | null;
  lastUiPatchSource: string | null;
}
```

When `activeTabId` is patched, ShellX restores the matching `activeTab`
context from `openTabs` when available and clears stale mismatched context
otherwise. Debug agents can compare `uiRevision` and `lastUiPatchSource`
when checking whether a renderer echo or automation patch won a race.

`POST /state/ui` also accepts renderer commands used by debug drivers.
Most are transient and only broadcast through the debug event stream;
`debugHighlights` and `debugHighlightResults` are also stored in the
returned snapshot so screenshot/video drivers can verify visible
callouts:

```ts
{
  source?: string;         // e.g. "renderer", "qa-replay", "debug-api"
  allowBuildTabMutation?: boolean;
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
  }>;                       // [] clears all callouts
}
```

`debugHighlights` draws non-interactive tutorial/demo callouts over the
running renderer. Targets are selected with CSS selectors plus optional
`index` and `text` filters, then measured from the real DOM with
`getBoundingClientRect()`. `debugHighlightResults` reports the target
`rect`, selector resolution status, and, when a target extends beyond the
visible window, the clipped on-screen `visibleRect` plus `clipped: true`.
Automation should wait for every required item to report
`status: "resolved"` before recording or capturing screenshots, and clear
callouts with `debugHighlights: []` before switching panels or modals.

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
| Tutorial/demo callout borders and labels | `debugHighlights` |

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
    status: string;
    active: boolean;
    surface?: { transport?: "local" | "wsl" | "ssh" | string; cwd?: string | null };
    nativeVisibility?: "observed" | "notExposed" | "notApplicable" | "shellxHost" | string;
    updatedAtMs?: number;
  }>;
}
```

Provider-native subagents are reported only when the provider CLI emits
an identifiable subagent/tool-use event. ShellX does not manage hidden
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

### 3.14 `GET /state/preview`, `GET /state/plan`, `GET /state/panels`

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
  autonomy?: "observe" | "propose" | "confirm" | "auto";
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

**Driver:** yes, base case exercised in `pnpm drive`.

### 5.2 `POST /abort` *(v1.0, exists — extended)*

Default behavior is a hard abort: it cancels the active prompt, removes the
tab's session registry entry, and the next `/prompt` for that tab requires a
fresh `/connect`.

Soft prompt-only cancel keeps the session entry alive. Use any one of:

```ts
POST /abort?keepSession=1
POST /abort { soft: true }
POST /abort { keepSession: true }
POST /abort { cancelPromptOnly: true }
```

Optional tab selectors are accepted as query/body `tabId`, `tab`, or
`tab_id`. The response shape is:

```ts
{ ok: true; tabId: string; registryRemoved: boolean; keepSession: boolean }
```

`POST /disconnect` is a semantic alias for hard `/abort` unless one of the
soft-cancel flags above is supplied.

**Driver:** not yet, but trivial to add.

### 5.3 `POST /autonomy`

```ts
{
  mode: "plan" | "acceptEdits" | "default" | "bypassPermissions" | "dontAsk"
      | "confirm" | "auto";
  sessionId?: string;            // alias of tabId
  tabId?: string;
}
```

Sets the Grok/ACP autonomy mode for the tab and the UI default used when a
Grok child is next spawned. Provider CLI sessions do not read this endpoint
directly; Debug API clients should pass `permissionMode` on
`/provider-sessions/start`. For a running Grok session the response includes
`appliesAfterReconnect: true` because the CLI flag is already baked into argv.

`auto` / `bypassPermissions` is Full Auto. It should be displayed and treated
as a warning-level mode because shell and host-tool actions can proceed without
per-action user approval.

**Response 200:** `{ ok, mode, tabId, appliesAfterReconnect }`.

### 5.4 `GET /autonomy?sessionId=<id>`

Returns `{ mode, sessionId }`.

---

## 6. Settings

### 6.1 `GET /settings`

```ts
{
  density: "compact" | "default" | "comfortable";
  theme: "black" | "black_warm";
  chatFontPx: number;               // 12..26
  permissionUx: "pill" | "modal" | "both";
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

Telegram `autoPrompt` is the first live session-chat connector. It
requires an enabled connector, an allowlisted chat id, and either a fixed
tab or the renderer-published active tab. shellX records the inbound
event, sends the message to the target ShellX session, returns the active session's text
reply back with Telegram `sendMessage`, and sends a referenced local
image path with `sendPhoto` when the reply includes one. Discord remains
DM intake/inbox only in this release.

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
the connector is configured for session chat.

---

## 10. GitHub

All GitHub endpoints check `gh auth status` first; on failure they
return `409 conflict` with `error.code: "gh_unauthenticated"` and
`error.data.connectUrl` pointing to the OAuth start URL.

### 10.1 `GET /github/state`

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
}
```

**Response 200:** `{ ok, url, output }` from `gh pr create`.
**Error 428 `approval_required`:** missing `confirmRemoteCreate: true`.
**Non-idempotent** without `idempotencyKey`.

### 10.3 `GET /github/issues/:id`

Fetch one issue with body, labels, comments. Cached 30s.

### 10.4 `POST /github/pr/:n/preview`

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

**Response 200:** `{ watchId: string }`. Watcher events arrive on the
`/events` WS with `kind: "fs-watch"`, `payload: { watchId, path, kind:
"created"|"modified"|"deleted", tMs }`.

A separate `DELETE /tools/fs_watch/:watchId` stops the watcher. Watchers
are scoped to the active session's cwd; paths escaping cwd return
`403 forbidden`.

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

Audit trail: every successful call writes a single entry to
`~/.shellx/audit.log` with `{ tMs, path, callerOrigin }` — never
the value. Failures log `{ tMs, path, reason }`.

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

### 14.1 `GET /events/recent` *(v1.0, exists — extended)*

**Existing:** `?limit=N` returns most-recent N events.

**v1.1 extensions:** all additive query params, AND-combined:

| Param | Type | Meaning |
| --- | --- | --- |
| `limit` | number | Existing. Default 200, cap = ring capacity (8192). |
| `since` | number (unix ms) | Only events with `t >= since`. |
| `sessionId` | string | Only events with `payload.sessionId == sessionId` OR no `sessionId` (global). |
| `kind` | string (repeatable) | Only events whose `kind` matches one of the given values. CSV form also accepted. |

Filters are applied to the **ring buffer in memory** — no replay across
restarts. For durable replay, see §17 (session-jsonl pickup).

### 14.2 `GET /events` *(WS, v1.0, exists — extended)*

WebSocket upgrade. Behavior matches v1.0: sends the recent backlog
first, then streams live.

**v1.1 extensions:** query params on the upgrade URL, same names as
`/events/recent`. They apply both to the backlog and to subsequent
live frames. Implementation: filter live frames in the per-socket
loop, not centrally — a slow filtered consumer can still lag without
stalling other subscribers.

Subscribers send `{ kind: "ping", t: <ms> }` to keep the connection
hot; the server replies `{ kind: "pong", t: <echoed-ms> }`.

A new frame kind, `{ kind: "ws-meta", payload: { warning: "lagged" } }`,
already exists in v1.0 and is now formalized. New `ws-meta` warnings
allowed: `"backlog-truncated"`, `"filter-rejected"`, `"closing"`.

---

## 15. Plan mode roadmap

The wired plan surface today is `POST /plan`, used to save or update a
plan document from a driver. The accept/reject/edit routes below are
roadmap notes, not shipped endpoints. `/build/*` is the shipped
long-horizon approval and receipt surface.

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

**Bearer auth is required on every endpoint except `/health`.** Read
the token from `~/.shellx/shellxagent.token` (the file is created
with `0600` permissions on first launch; older installs are
auto-migrated) and pass it as:

```
Authorization: Bearer <token>
```

Mismatch returns `401 unauthorized`. The WS upgrade reads the token from a
query param `?token=<>` because browsers do not support custom headers on WS.

Token resolution order on the server side:
1. `SHELLX_DEBUG_SECRET` env var (overrides the file, used for CI)
2. `GROK_SHELL_DEBUG_SECRET` legacy env var
3. `~/.shellx/shellxagent.token` (auto-created, 32 hex chars, `0600`)

ShellX also writes `~/.shellx/shellxagent.json` with the bound
`url`, `browserAction`, `browserState`, `browserTabs`, `events`,
and `health` endpoints for local tool discovery. For normal file-token
installs it includes the same bearer token as `shellxagent.token`; when
auth is overridden by an env var, the descriptor omits the env token so
the override is not persisted. The descriptor intentionally advertises
`rawCdpExposed: false`; Browser automation must continue through the
gated `/browser/*` Debug API routes.

Authenticated clients can also fetch the live descriptor from
`GET /shellxagent.json` or `GET /.well-known/shellxagent.json`. This
served copy omits the token field value because the caller has already
authenticated and can read `tokenFile` when it needs to reconnect.

Agent-facing documentation is bundled into the desktop binary and exposed
in two ways on every fresh install:

- On disk: `~/.grok/skills/shellx-host/SKILL.md`,
  `~/.codex/skills/shellx-host/SKILL.md`,
  `~/.claude/skills/shellx-host/SKILL.md`, and
  `~/.shellx/agent-docs/shellx-host/SKILL.md`.
- Over the authenticated Debug API: `GET /agent-doc/manifest` and
  `GET /agent-doc/skills/shellx-host/SKILL.md`.

`/health` is the only endpoint exempt from auth — it's the liveness
probe used by drivers waiting for the app to come up.

The host MCP HTTP server (separate port, published to
`~/.shellx/mcp-http.port`) uses an independent token at
`~/.shellx/mcp.token`. Rotate the two tokens independently.

---

## 17. Logging + audit

### 17.1 Per-request log line

Every HTTP request produces exactly **one** log line at `info` level:

```
debug_api: METHOD PATH status=<code> ms=<elapsed> in=<bytes> out=<bytes> session=<id-or-->
```

WS upgrades log `WS PATH status=101 session=<id-or-->` once, plus one
line on close with frame count and reason.

### 17.2 Body redaction

Bodies are **not** logged by default. The exceptions, all of which
log scrubbed snippets only:

| Endpoint | What gets logged | What gets dropped |
| --- | --- | --- |
| `POST /prompt` | First 80 chars of prompt + length | Attachments, full prompt |
| `POST /settings` | List of keys touched | Values, especially `github.token` |
| `POST /tools/secret_get` | nothing (path treated as sensitive) | path, value |
| `POST /github/pr/create` | base, head, title length | body, transcript |

The active agent's stderr is already pipelined into the events firehose
and into `~/.shellx/sessions/<sid>.jsonl` for capture mode. The debug API
log is **separate** — it tracks who's driving the surface, not what
the agent is doing.

### 17.3 Audit log

`~/.shellx/audit.log`, append-only JSONL, one line per
auth-sensitive event:

```ts
{ tMs: number, event: "secret_get" | "github_pr_create" | "delete_session" | "skill_install",
  callerOrigin: string, details: object }
```

`callerOrigin` is best-effort (peer socket address; loopback addresses
only in v1). Token id (not the secret) is recorded for bearer-auth
requests.

Audit log is **never** rotated automatically. Operators rotate via
standard logrotate or by hand.

---

## 18. Driver coverage

`pnpm drive` is the v1.0 client. Its coverage as of
this spec:

| Endpoint | Driver coverage |
| --- | --- |
| `GET /health` | yes |
| `GET /events/recent` | implicit via WS backlog |
| `GET /events` (WS) | yes |
| `POST /connect` | yes |
| `POST /prompt` | yes (no attachments, no sessionId) |
| `POST /abort` | no |
| Everything else in this spec | no |

The v1.1 driver milestone is to add: `GET /`, `GET /version`, `POST
/sessions`, `POST /sessions/:id/switch`, `DELETE /sessions/:id`,
`POST /autonomy`, `GET /settings` / `POST /settings`, and
`POST /preview`. These eight together unblock automated end-to-end
verification of every left-rail, header, and right-pane behavior in
the legacy UI design checklist.

The v1.2 driver milestone adds the native-host tools (`/tools/*`) and
terminal (`/terminal/*`). Those need a small `expect`-style helper
inside the driver so prompts/responses can be scripted against PTY
output.

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
