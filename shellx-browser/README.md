# ShellX Browser

ShellX Browser is a ShellX-owned browser module, not a separate product or a
provider CLI feature. It opens as a desktop window from ShellX, stores browser
task/profile state in the ShellX host, and exposes agent-control primitives
through the existing local Debug API.

The design goal is a trusted local automation surface:

- the user owns the browser profiles, cookies, grants, reports, and receipts;
- local or remote provider agents receive observations, refs, approved actions,
  and trace receipts through ShellX;
- credentials and raw secrets stay in the ShellX host/Vault path and are not
  handed to provider CLIs unless the user explicitly exports them.

## Runtime Shape

The runtime is split between the ShellX host state, Debug API, renderer chrome,
and the native child webview engine:

- `src-tauri/src/shellx_browser.rs` owns profiles, tasks, navigation state,
  session grants, Vault deposits, reports, and receipts.
- `src-tauri/src/debug_api.rs` exposes `/browser/*` routes using the existing
  Debug API bearer token and event stream.
- `src/components/ShellxBrowserApp.tsx` is the renderer surface mounted for the
  `shellx-browser` Tauri window.
- Browser extraction is task-scoped: collect only the evidence needed for the
  current request and keep retained artifacts receipt-backed.
- The Browser chrome mounts a native child webview for page loading,
  observation, extraction, and deterministic DOM controls.
- Browser actions that are blocked by missing engine state, policy gates, or
  operator-only decisions return structured `requiresEngine`, approval, or
  denial responses instead of fake success.
- Browser tabs are first-class host objects. A tab can be locked to an
  agent/run lease so another agent cannot accidentally observe or mutate it.

Default profiles stay intentionally small:

- `personal`: user-driven browsing, agent access requires a session grant.
- `agent-work`: default persistent agent profile.
- `task-disposable`: isolated no-cookie profile for one-off workflows.

Workflow entries such as AWS, GitHub, Huntr, docs, or Vault are bookmarks and
task presets, not separate browser profiles.

## Vault And Session Grants

Vault grants and browser session grants are separate:

- a Vault grant controls whether the ShellX host may fill a secret into an
  origin-bound field;
- a browser session grant controls whether an agent profile may reuse session
  state from another ShellX browser profile.

The model-facing observation stream must never echo raw secrets. Secret-backed
fields and filled controls are treated as tainted and redacted in observations.
Fill operations must be host-owned: set the DOM value, dispatch `input` and
`change`, and avoid synthetic keystroke replay that could leak through model
logs.

Write-only Vault deposits use a split receipt model:

- the Vault/quarantine server receipt is minimal: `id`, `payloadHash`,
  `createdMs`, and `fromToken`;
- ShellX trace receipts carry richer operator context such as label, origin,
  task id, source URL, and approval trail;
- the agent can create a pending deposit but cannot read the secret back.

## Debug API Routes

Host MCP exposes the Browser through thin Debug API wrappers:
`browser_state`, `browser_tabs`, `browser_locks`, `browser_navigate`,
`browser_observe`, `browser_click_ref`, `browser_click_at`, `browser_fill_ref`,
`browser_type_text`, `browser_clear_site_data`, `browser_wait_for`,
`browser_extract`, `browser_verify`, `browser_screenshot`, and
`browser_trace_open`. Vault-backed wrappers include
`browser_fill_from_vault`, `browser_fill_profile_card`,
`browser_capture_secret_to_vault`, `browser_read_email_code`, and
`browser_use_agent_wallet`. Agents should use this native Browser flow for web
tasks: inspect tabs/state, navigate with `browser_navigate`, observe refs with
`browser_observe`, act on refs, then verify, capture a full-page screenshot when
visual evidence matters, or export a redacted trace. When `browser_observe`
returns redacted `secret-*` refs for API keys, generated passwords, or tokens,
agents should pass the ref to `browser_capture_secret_to_vault` with a durable
Vault ref instead of reading clipboard/raw values. For canvas or rich-editor
surfaces with no usable DOM ref, agents should capture screenshot evidence and
then use viewport-coordinate `browser_click_at` / `browser_type_text`; normal
inputs should still use refs. If a visible ref click reports applied but a
Google-style menu/page state does not change, retry the same ref with
`browser_click_ref force=true` to dispatch native pointer input. For split
buttons/dropdowns where the whole-button ref still does not change state, use
full-page screenshot evidence and coordinate-click the visible arrow/subtarget. Use
`browser_screenshot` with `fullPage=true` for
coordinate work so the returned `pageWidth`/`pageHeight` and MCP `cssScale`
summary can convert image pixels into CSS viewport coordinates. If a page
reports broken app resources, `browser_clear_site_data` clears browser cache
plus non-cookie current-origin storage and reloads. If the page still asks to
clear cookies, agents should request user approval before any sign-in-resetting
cleanup. These wrappers do not own a
second browser engine or a separate policy layer. Locks, actionability,
receipts, approvals, and redaction remain owned by `/browser/*`.

Read routes:

- `GET /browser/state`
- `GET /browser/tabs`
- `GET /browser/profiles`
- `GET /browser/tasks`
- `GET /browser/bookmarks`
- `GET /browser/receipts`
- `GET /browser/privacy`
- `GET /browser/downloads`
- `GET /browser/uploads`
- `GET /browser/logs`
- `GET /browser/storage-state`
- `GET /browser/dialogs`
- `GET /browser/permissions`
- `GET /browser/popups`
- `GET /browser/network`
- `GET /browser/robots`

Browser privacy/ad-mode mutation is operator-owned. The app UI calls the Tauri
`shellx_browser_update_privacy` command; Debug API `POST /browser/privacy`
returns `browser_privacy_requires_operator` and must not be used by agents.
Browser Shields mutation follows the same boundary through
`shellx_browser_update_shields`, `shellx_browser_update_site_shields`, and
`shellx_browser_remove_site_shields`; Debug API Shields write routes return
`browser_shields_requires_operator`.
Browser Developer Mode follows the same operator boundary. The app UI/Tauri
commands `shellx_browser_update_developer_mode` and
`shellx_browser_approve_developer_mode_host` own full-CDP enablement and host
approval; Debug API Developer Mode writes return
`developer_mode_requires_operator`.

Action routes:

- `POST /browser/open`
- `POST /browser/tabs/open`
- `POST /browser/tabs/focus`
- `POST /browser/tabs/close`
- `POST /browser/tabs/lock`
- `POST /browser/tabs/heartbeat`
- `POST /browser/tabs/unlock`
- `POST /browser/task/start`
- `POST /browser/task/autonomy`
- `POST /browser/task/control`
- `POST /browser/task/finish`
- `POST /browser/action`
- `POST /browser/logs`
- `POST /browser/downloads/request`
- `POST /browser/downloads/complete`
- `POST /browser/uploads/request`
- `POST /browser/uploads/complete`
- `POST /browser/cdp/execute`
- `POST /browser/trace/export`
- `POST /browser/har/export`
- `POST /browser/performance/export`
- `POST /browser/recipes/export`
- `POST /browser/recipes/replay`
- `POST /browser/robots/schedule`
- `POST /browser/robots/run`
- `POST /browser/robots/cancel`
- `POST /browser/storage-state/export`
- `POST /browser/dialogs`
- `POST /browser/dialogs/resolve` (operator-only denial path for Debug API)
- `POST /browser/permissions`
- `POST /browser/permissions/resolve` (operator-only denial path for Debug API)
- `POST /browser/popups`
- `POST /browser/session-grants/request`
- `POST /browser/session-grants/resolve` (operator-only denial path for Debug API)
- `POST /browser/session-grants/apply`
- `POST /browser/vault-deposits` (stores in Vault first, then returns a redacted receipt)
- `POST /browser/report`

Every state-changing route emits or stores a browser receipt. Error-level
Browser console logs also emit `browserConsoleError` receipts. The Debug API
emits `browser-event` frames so external drivers can record an auditable trace.
`/browser/logs` is the agent-readable equivalent of opening DevTools Console:
it exposes bounded page/runtime errors with URL and line/column metadata when
the engine or Browser UI reports them.
`observe` returns bounded `text`/`markdown`, a `snapshotId`, selector-backed refs, a compact
`domSummary`, a structured `formFields` map, and an `accessibilityTree` control
summary. This gives agents enough page structure for navigation and editing
without treating observation as a raw-page cache.
Selector-backed refs include locator suggestions, bounds, visibility/enabled/
editable state, frame id, and strict-match counts so agents can choose stable
targets instead of falling back to coordinates.
Engine actions return actionability evidence in the response and receipt. Hidden,
covered, or otherwise non-actionable targets return `notActionable`; covered
targets include `actionability.coveringElement` so agents can identify an overlay,
consent prompt, or app layer before retrying. `findText` searches
inside the current page, scrolls the first visible match into view, and records
bounded match metadata with a `browserFindTextCompleted` receipt. `verify`
records text, URL, element, table, and schema checks with pass/fail receipts.
Action responses may include a compact `stepSummary` so agents can continue
without always requesting a full observation. The summary contains action/status,
snapshot id, current URL, title, security level, page status, bounded control
counts, target ref/selector metadata, failed actionability checks, locator
recovery candidates, suggested next action names, and recovery hints. It never
carries raw page text, markdown, form values, typed values, cookies, headers,
local storage, screenshots, or secrets.
`captureScreenshot` saves a Browser-window PNG artifact under
`~/.grok/shellx-browser-screenshots/` and returns path, bytes, SHA-256, and
dimensions with a `browserScreenshotCaptured` receipt. With `fullPage=true`, the
artifact is page content and includes CSS page dimensions for coordinate
conversion.
`/browser/trace/export` saves a bounded JSON artifact under
`~/.grok/shellx-browser-traces/` with task/tab/engine state, last-observation
metadata, recent receipts, console logs, transfer intents, privacy settings, and
redaction policy. Trace bundles intentionally omit raw DOM, cookies,
local-storage values, network bodies, raw secrets, and full screenshots.
`/browser/cdp/execute` is gated by Browser Developer Mode full-CDP approval for
the active host, then returns redacted results plus a
`browserCdpCommandExecuted` receipt. `/browser/har/export` and
`/browser/performance/export` write hashed redacted artifacts under
`~/.grok/shellx-browser-har/` and `~/.grok/shellx-browser-performance/`.
`/browser/recipes/export` writes Action Recipe V2 manifests without raw typed
values. The manifest keeps the workflow goal, redacted steps, variable input
placeholders, assertions, decision-point notes, source receipt references, and a
redaction policy so replay can adapt from fresh observations instead of freezing
one page's selectors. `/browser/recipes/replay` and `/browser/robots/*` provide
dry-run and scheduled work-queue receipts for agent-driven browser workflows.
`/browser/storage-state` exposes safe storage manifests only: profile id,
storage root, cookie/local-storage policy, retention policy, and grant status.
`/browser/storage-state/export` writes the same value-free manifest as a hashed
artifact under `~/.grok/shellx-browser-storage-state/`. It does not expose
cookie values, local-storage values, headers, network bodies, or raw secrets.
`/browser/session-grants/request` records an agent request for profile session
reuse. Resolving that request is operator-owned: Debug API callers receive
`browser_session_grant_resolution_requires_operator`, while the
`shellx_browser_resolve_session_grant` Tauri command applies the operator/UI
decision. `/browser/session-grants/apply` succeeds only after a host-approved
profile session grant has been made available to the destination profile. It
emits `browserSessionGrantApplied`; real cookie/session copying is intentionally left
for the ShellX Vault/session bridge.
Dialog, permission, popup, and network routes are metadata surfaces for agent reliability.
`/browser/dialogs` records alert/confirm/prompt events, and
`/browser/permissions` records notification/geolocation/camera/microphone/
clipboard-style page permission requests with safe origin/path only and
query/fragment redaction flags. Decisions are operator-owned: Debug API resolve
calls return `browser_prompt_resolution_requires_operator`, while the ShellX
operator/UI Tauri commands `shellx_browser_resolve_dialog` and
`shellx_browser_resolve_permission` apply the decision without echoing prompt
values. Native WebView permission requests and limited page-side permission
signals are ingested automatically and fail closed until ShellX has an explicit
operator decision path for that request.
`/browser/popups` records popup/new-window requests with query and fragment redacted from target URLs.
`/browser/network` returns bounded navigation/load/download/popup metadata with
safe origin/path URLs, privacy decisions, and explicit header/body redaction
flags. It does not expose a reusable hash of the hidden full URL.
Transfer completion is approval-bound. `/browser/downloads/complete` and
`/browser/uploads/complete` update an existing transfer only when the caller
supplies a host-granted `approvalId`, `retentionReason`, bytes, SHA-256, and
final path metadata. The ShellX operator/UI Tauri command
`shellx_browser_grant_transfer` mints transfer approval IDs; Debug API callers
cannot self-issue them. Completion records MIME/content kind, safe source URL,
destination, retention reason, and emits `browserDownloadCompleted` or
`browserUploadCompleted`.

Private/local task navigation is explicit. Agent tasks can browse public
`http`/`https` targets normally, but loopback, link-local, RFC1918, `.local`,
metadata hosts, and DNS names that resolve to private/local addresses must match
the task `expectedDomains` before `startUrl` or `navigate` is accepted. Manual
taskless personal-profile browsing can still open local development pages.
Agent navigation, observation, extraction, form fills, clicks, scrolling, tab
locks, receipts, and console-log reads are designed to keep working while the
Browser window is in the background or minimized. Explicit Browser open/focus
commands may show the window; visual screenshot capture remains the one action
class that can require a rendered window surface until engine-native page
screenshots are added.
`/browser/state` also carries bounded in-memory history, and
`/browser/action` supports `bookmarkCurrent` for saving the active task URL as a
user-visible bookmark without giving agents broader browser-profile control.
History clearing is a local Browser-window command after user confirmation;
`clearHistory` over the debug API is classified as destructive and blocked until
an approval flow exists for that action class. Direct registry mutation without
the ShellX operator path returns `browser_destructive_action_requires_operator`;
the Browser UI uses the `shellx_browser_clear_history` Tauri command.

## Tabs, Privacy, And File Transfers

Each Browser tab carries `browserTabId`, task/profile binding, active state,
storage root, privacy mode, and optional lock lease. Mutating actions and
observations against a locked tab must include the matching `lockLeaseId`,
`ownerAgentId`, and `ownerRunId`. Non-owners receive `status:"tabLocked"` with a
`browserTabLockDenied` receipt.

Privacy/ad modes are user controlled. Only three modes are user-facing:

- `off`: compatibility fallback that disables ShellX ad/tracker handling and
  clears stale Shields counters for the active profile/site.
- `balanced`: default profile mode for local presentation suppression and
  deterministic tracker/ad decisions. The mounted WebView applies common
  cosmetic ad cleanup plus local guards for frequent ad/tracker fetch, beacon,
  XHR, popup, and dynamically inserted script requests.
- `strict`: Windows WebView2 native request filtering plus the balanced local
  cleanup path. Matching ad/tracker subresources are answered before they load;
  this is stronger and can break pages that couple core UI to ad scripts.

Shields are also user controlled. Defaults are compatibility-first:
`balanced` ad/tracker handling, third-party cookie blocking, compatibility
fingerprinting protection, HTTPS upgrades enabled, and script blocking off until
the user enables it for a site. Per-site overrides are local policy metadata and
do not expose cookies, local storage, request headers, or response bodies. The
strict mode is the request-filter path for Brave/uBlock-style blocking on the
native Windows engine; non-Windows builds keep the local balanced behavior until
an equivalent native request hook is implemented.

ShellX Browser is a clean private browser surface, not a monetized attention
surface. ShellX does not run browser-owned ads, rewards, crypto prompts,
browser wallet upsells, sponsored new-tab content, or URL affiliate rewriting.
The user controls what is hidden, what is shared, and what is delegated to an
agent.

Balanced cosmetic cleanup is not an undetectable bypass. Sites can still detect
viewability, geometry, loaded resources, hidden regions, timing, and interaction
patterns. It is a user comfort and compatibility feature, and it never performs
fake clicks, fake conversions, or forged engagement.

Downloads and uploads are explicit intent records. The Browser chrome includes
a Downloads header status badge plus a left-side Downloads sidecar that shows
requested/completed transfers. The sidecar and ShellX Settings share the local
default download folder setting. Manual page-save actions queue visible transfer
intents, pass optional `destinationDir` metadata, and open the manager instead
of silently doing nothing. Agents should call `/browser/downloads/request` or
`/browser/uploads/request` only when the user or task asks for a file transfer.
Raw `downloadFile` and `uploadFile` actions remain approval-gated. Pending
session grants tied to a Browser task are closed automatically when that task
completes, aborts, or enters user takeover.

## Safety Rules

Allowed under task autonomy: browsing, navigation, page observation, extraction,
ordinary non-sensitive field input, and report drafting.

Always gated by explicit approval or a pre-existing scoped grant:

- credential/session use;
- payments or wallet spend;
- final submit/publish/send actions not named by the user's task;
- delete/destructive actions;
- security setting changes;
- raw secret reveal/export;
- long-lived access outside the grant envelope;
- software install/extension install;
- executing downloaded code.

Safe extraction follows the same principle as web search: collect only the
task-relevant evidence, save raw files only when the user/task asks for them,
and attach receipts to any retained structured data, Markdown evidence,
screenshot, or original download. Magika can classify saved artifacts before
preview or conversion, MarkItDown can produce compact Markdown evidence from
selected documents, and Maxun-style recorder ideas are used only as design
inspiration for ShellX-owned recipes.

## Current Engine Status

The Debug API, task state, profile state, policy gates, receipts, ShellX Browser
window, and native child webview engine are live. `observe`, `extractText`,
`extractMarkdown`, `click`/`clickRef`, `fillRef`/`type`, `scroll`, `waitFor`,
`select`, `press`, `extractTable`, `captureScreenshot`, `verify`, `findText`, `goBack`,
`goForward`, and `reload` use the native engine when it is mounted. Engine
observations include DOM counts, locator suggestions, form field metadata, and
an accessibility-style control list for Debug API drivers. Engine actions
include actionability evidence, and verification actions emit explicit
`browserVerificationPassed` or `browserVerificationFailed` receipts. Page search
actions emit `browserFindTextCompleted` receipts with bounded match metadata.

Downloads, uploads, credential-backed fills, final submit/publish, destructive
actions, raw secret reveal, and similar sensitive operations remain gated.
Durable screenshot artifacts, page-save text/Markdown artifacts, download
intent records, and approval-bound transfer completion are available. Native
bulk download/upload automation remains gated and should rely on explicit
operator approval plus completed transfer metadata before an agent treats a
file path as usable.

## Vault Credentials

Vault credential fills and generated passwords are mediated by ShellX. Browser
receipts carry item id, origin, grant id, route, and `secretExposed:false`; they
do not carry the password or API key. Write-only Vault deposits use
`/browser/vault-deposits`, commit the value to ShellX Vault first, and include
only a Vault reference plus storage commit hash for receipt correlation.

Vault resources extend the same boundary to structured data. Profile cards,
email inboxes, and Stripe agent wallets are stored as encrypted Vault resources
with redacted metadata (`resourceKind`, summary, provider, and field names).
Agents can discover non-user-only resources through `/vault/resources`, then ask
for scoped grants. `fillProfileCardGrant` injects one approved profile-card
field into a Browser form without returning the full card. `readEmailCodeGrant`
returns only a short verification code from an approved provider-neutral inbox
resource. `useAgentWalletGrant` prepares Stripe agent-wallet checkout metadata;
ShellX does not store generic user payment cards.
