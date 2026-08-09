use serde_json::{json, Value};

use super::browser_action_schema_properties;
use super::browser_entry::{BROWSER_ACT_ACTIONS, BROWSER_READ_ACTIONS};

/// Compact Browser surface advertised in MCP `tools/list`. The legacy named
/// tools below remain callable and searchable on demand for resumed sessions
/// and exact-schema discovery.
pub(super) fn browser_entry_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "browser_read",
            "description": "Read or verify native ShellX Browser state through one token-bounded entry point. Common flow: action=tabs, then navigate with browser_act, then action=observe for refs. Observe defaults to a 3000-byte structured payload; action=evidence lists owned recorder/evaluation receipts. Use search_tool for uncommon exact fields.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "action": { "type": "string", "enum": BROWSER_READ_ACTIONS },
                    "taskId": { "type": "string" },
                    "browserTabId": { "type": "string" },
                    "refId": { "type": "string" },
                    "selector": { "type": "string" },
                    "value": { "type": "string" },
                    "key": { "type": "string" },
                    "format": { "type": "string" },
                    "query": { "type": "string" },
                    "timeoutMs": { "type": "integer" },
                    "fullPage": { "type": "boolean" },
                    "maxPayloadBytes": { "type": "integer", "description": "Observe structured-response budget; default 3000, range 1500..64000." },
                    "fullObservation": { "type": "boolean", "description": "Explicit unbudgeted observe dump." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "browser_act",
            "description": "Mutate the native ShellX Browser through one permission-gated entry point. Use action=navigate, observe with browser_read, then click/fill refs; runSteps batches a short sequence. Recorder export and evaluation use flightRecorderExport/evaluationWrite. Sensitive and artifact actions retain ShellX gates; use search_tool for exact fields.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                    "action": { "type": "string", "enum": BROWSER_ACT_ACTIONS },
                    "url": { "type": "string" },
                    "taskId": { "type": "string" },
                    "browserTabId": { "type": "string" },
                    "refId": { "type": "string" },
                    "selector": { "type": "string" },
                    "value": { "type": "string" },
                    "key": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "steps": { "type": "array", "items": { "type": "object" }, "maxItems": 20 },
                    "grantId": { "type": "string" },
                    "secretRef": { "type": "string" },
                    "resourceRef": { "type": "string" },
                    "timeoutMs": { "type": "integer" }
                },
                "required": ["action"]
            }
        }),
    ]
}

pub(super) fn browser_tool_specs() -> Vec<Value> {
    vec![
        // ─── ShellX Browser Debug API wrappers ───
        // Thin wrappers only: the Browser registry, locks, receipts,
        // extraction, and actionability remain owned by /browser/*.
        json!({
            "name": "browser_state",
            "description": "Read a bounded native ShellX Browser summary through `/browser/summary`. The default response stays under the Browser orientation budget and excludes prior observations, receipts, network, history, and console logs. Pass `include` only for the detail slices needed now; `observations` is explicit and potentially large. Agent flow: orient with browser_state/browser_tabs, use browser_navigate, then browser_observe for current-page refs. Do not save raw state JSON to the current working directory or user folders; use browser_trace_open for bounded evidence.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["tabs", "tasks", "profiles", "bookmarks", "history", "receipts", "network", "logs", "requests", "transfers", "settings", "observations"] },
                        "maxItems": 12,
                        "description": "Optional detail slices. Heavy history, receipts, network, logs, and observations are never returned unless named here."
                    },
                    "limit": { "type": "number", "minimum": 1, "maximum": 1000, "default": 100, "description": "Bound for list detail slices." }
                }
            }
        }),
        json!({
            "name": "browser_check",
            "description": "Run a bounded quiet check through Debug API `/browser/check`. It reports Browser liveness plus current task/tab/engine settlement without starting a task, opening or focusing the Browser window, mounting an engine, navigating, observing page DOM, or emitting receipts. Use this when the agent only needs to confirm current Browser state and the user does not need to watch. Use net_fetch for plain HTTP status/content checks that need no Browser session; use browser_observe and the visible native ShellX Browser when rendered-page evidence or interaction is required.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string", "description": "Optional existing Browser task to check. Never creates one." },
                    "browserTabId": { "type": "string", "description": "Optional existing Browser tab to check. Never focuses it." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 120000, "default": 0, "description": "Optional server-side settle wait. Zero returns immediately; no client polling is required." }
                }
            }
        }),
        json!({
            "name": "browser_rendered_check",
            "description": "Load one public or explicitly scoped local page in a bounded incognito hidden renderer and return redacted match/count evidence without returning page text or titles and without opening/focusing the visible ShellX Browser, creating a Browser task/tab, using personal cookies, emitting receipts, or persisting a profile. Cross-origin fetch, XHR, WebSocket, and beacon calls are blocked and a restrictive CSP is injected, but this is not a general network sandbox. Use this for JavaScript-rendered liveness, text, title, or selector checks when the user does not need to watch and no interaction or authenticated session is required. Use browser_check for state-only Browser liveness, net_fetch for plain HTTP, and the visible native ShellX Browser for authenticated, interactive, approval-bearing, or human-cowork work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Page URL to render. Private/local targets require matching expectedDomains." },
                    "expectText": { "type": "string", "maxLength": 500, "description": "Optional body text to wait for and match without returning page text." },
                    "titleIncludes": { "type": "string", "maxLength": 500, "description": "Optional title text to wait for." },
                    "selector": { "type": "string", "maxLength": 500, "description": "Optional CSS selector to wait for." },
                    "caseSensitive": { "type": "boolean", "default": false },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 30000, "default": 10000 },
                    "settleMs": { "type": "integer", "minimum": 0, "maximum": 2000, "default": 250, "description": "Small post-load delay before the first rendered evidence check." },
                    "expectedDomains": { "type": "array", "maxItems": 20, "items": { "type": "string" }, "description": "Required explicit scope for private/local hosts and redirects." }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "browser_tabs",
            "description": "Read native ShellX Browser tabs through the Debug API `/browser/tabs`, including active tab, task/profile binding, and lock state. Agent flow: choose a tab, use browser_navigate when navigation is needed, then browser_observe for refs before acting.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "browser_locks",
            "description": "Read locked native ShellX Browser tabs by calling the Debug API `/browser/tabs` and returning only tabs with active lock metadata. Agent flow still uses browser_navigate, browser_observe, and lock-aware actions through Browser gates.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "browser_observe",
            "description": "Observe the native ShellX Browser page through Debug API `/browser/action` with action `observe`. MCP output is compact by default and has a 3000-byte structured-response budget: bounded deterministic refs, opaque element fingerprints, form fields, accessibility nodes, snapshotId, a bounded delta from the prior observation, and short text/markdown previews so provider sessions stay fast on heavy pages. The response reports its serialized byte count and approximate token count. The compact summary reports changed, refDelta, and changeKinds; changed=false means the agent can avoid re-planning an unchanged page. Unchanged controls keep the same ref across observations. Agent flow: use browser_navigate or select an existing task tab, then browser_observe to get refs, locator suggestions, actionability metadata, and receipts; pass maxRefs/maxFormFields/maxAccessibilityNodes/includePageText/maxPayloadBytes only when needed, or fullObservation=true for an explicit unbudgeted dump. API-key/token pages may return redacted `secret-*` refs with action `capturePageSecretToVault`; pass those refs to browser_capture_secret_to_vault rather than using clipboard reads, raw reveal, or hand-built XPath. If a rich editor/canvas area has no editable ref, use browser_screenshot for coordinates, then browser_click_at/browser_type_text. If no task/tab is supplied, ShellX creates or reuses a task-disposable task bound to this MCP caller instead of touching personal tabs or another caller's cowork task. Pass an explicit taskId to join an existing cowork task. Do not write raw observation dumps to the current working directory or user folders; use browser_extract for page content and browser_trace_open for diagnostic evidence.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_navigate",
            "description": "Navigate the native ShellX Browser to a URL through Debug API `/browser/action` with action `navigate`. Agent flow: call browser_navigate for web tasks, then browser_observe for refs before clicking/filling/waiting. If no task/tab is supplied, ShellX creates or reuses a task-disposable task bound to this MCP caller; it does not default to personal tabs or another caller's cowork task. Pass an explicit taskId to join a cowork task, and pass both browserTabId and taskId for an existing task/delegated tab.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["url"]
            }
        }),
        json!({
            "name": "browser_click_ref",
            "description": "Click a native ShellX Browser observation ref or precise selector through Debug API `/browser/action` with action `clickRef`. Agent flow: browser_navigate if needed, browser_observe first to get refs, then click; use selector only when the task already has a stable selector from a fixture, saved workflow, or prior observation. If notActionable/notFound, inspect stepSummary.failedChecks, actionability.coveringElement, and stepSummary.locatorCandidates before retrying from a fresh observe. If status is staleRef or failedChecks contains fingerprint, ShellX did not act: re-observe and use the replacement ref; force and locator recovery must not bypass identity validation. Pass `lockLeaseId`/owner fields for locked agent tabs.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "anyOf": [
                    { "required": ["refId"] },
                    { "required": ["selector"] }
                ]
            }
        }),
        json!({
            "name": "browser_click_at",
            "description": "Click native ShellX Browser viewport coordinates through Debug API `/browser/action` with action `clickAt`. Use only after browser_observe/browser_screenshot when a real page surface, canvas editor, rich editor, or visual-only app overlay has no usable DOM ref. Coordinates are CSS viewport pixels inside the current Browser page, not screen pixels; with browser_screenshot fullPage=true, divide image pixels by cssScale before calling, re-capture after Browser resize/minimize/restore, and scroll off-screen full-page targets into the visible viewport before coordinate-clicking. Prefer browser_click_ref whenever a ref exists.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["x", "y"]
            }
        }),
        json!({
            "name": "browser_fill_ref",
            "description": "Fill a native ShellX Browser observation ref or precise selector through Debug API `/browser/action` with action `fillRef`. Agent flow: browser_navigate if needed, browser_observe first to get refs, then fill; use selector only when the task already has a stable selector from a fixture, saved workflow, or prior observation. If status is staleRef or failedChecks contains fingerprint, ShellX did not fill: re-observe and use the replacement ref. For ordinary locator drift, inspect stepSummary.locatorCandidates after re-observing. Use Vault-mediated fills for credentials and keep Browser security/approval gates in control.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["value"],
                "anyOf": [
                    { "required": ["refId"] },
                    { "required": ["selector"] }
                ]
            }
        }),
        json!({
            "name": "browser_type_text",
            "description": "Insert text at native ShellX Browser viewport coordinates through Debug API `/browser/action` with action `typeText`. Use for rich editors/canvas surfaces such as Google Docs after browser_screenshot fullPage=true confirms the target point. Coordinates are CSS viewport pixels inside the current Browser page; divide screenshot pixels by cssScale when using screenshot evidence, re-capture after Browser resize/minimize/restore, and scroll off-screen targets into view before typing. Prefer browser_fill_ref for normal inputs and never use this to bypass Vault-mediated credential fills.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["x", "y", "value"]
            }
        }),
        json!({
            "name": "browser_clear_site_data",
            "description": "Clear non-cookie application storage for the current native ShellX Browser origin through Debug API `/browser/action` with action `clearSiteData`, then reload the page. WebView2 also clears its HTTP cache and reloads ignoring cache; WebKit clears origin Cache Storage, IndexedDB, local/session storage, and service workers with a bounded best-effort result. Use for page-reported app-resource corruption such as Google Sheets 'Loading issue' prompts. Cookies/sign-in are preserved and the operation is scoped to the current origin.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_run_steps",
            "description": "Run a short ordered batch of generic native ShellX Browser action steps through the same Debug API `/browser/action` path used by browser_navigate/browser_observe/browser_click_ref. This improves speed by reducing MCP round trips, but it is not a site script runner: each step is a normal Browser action, Browser/Vault/lock/dialog/actionability gates remain authoritative, and unsupported or sensitive actions stop before execution. Use for generic Browser action steps such as navigate -> waitFor -> observe -> clickRef -> scroll -> select -> findText -> extractTable -> verify after you have a clear task plan; keep Vault fills, secret capture, wallet/email grants, approvals, coordinate-only actions, uploads/downloads, and beforeunload resolution as separate explicit tools.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "description": "Ordered generic Browser action steps. Supported action values: navigate, observe, clickRef, fillRef, press, pressKey, waitFor, verify, findText, scroll, select, goBack, goForward, reload, extractText, extractMarkdown, extractTable, captureScreenshot.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": { "type": "string", "description": "Generic Browser action for this step." },
                                "browserTabId": { "type": "string" },
                                "taskId": { "type": "string" },
                                "url": { "type": "string" },
                                "selector": { "type": "string" },
                                "refId": { "type": "string" },
                                "value": { "type": "string" },
                                "query": { "type": "string", "description": "Convenience alias for findText; Host MCP maps it to value before calling /browser/action." },
                                "key": { "type": "string" },
                                "fullPage": { "type": "boolean" },
                                "force": { "type": "boolean" },
                                "timeoutMs": { "type": "integer" }
                            },
                            "required": ["action"]
                        }
                    },
                    "continueOnError": { "type": "boolean", "default": false, "description": "Flow control only. When false, stop after the first validation, target, transport, navigation-settle, or Browser action failure. When true, attempt later steps, but aggregate ok remains false and isError remains true when any step fails." },
                    "browserTabId": { "type": "string", "description": "Optional common Browser tab id applied to steps that omit one. If present, taskId is also required." },
                    "taskId": { "type": "string", "description": "Optional common Browser task id applied to steps that omit one." },
                    "lockLeaseId": { "type": "string", "description": "Optional common Browser tab lock lease for all steps." },
                    "ownerAgentId": { "type": "string", "description": "Optional common Browser lock owner agent id." },
                    "ownerRunId": { "type": "string", "description": "Optional common Browser lock owner run id." },
                    "timeoutMs": { "type": "integer", "default": 30000 }
                },
                "required": ["steps"]
            }
        }),
        json!({
            "name": "browser_workflows",
            "description": "List Agent workflow bookmarks saved in the native ShellX Browser. Use this before repeating a known site workflow or intent such as get/api-key: filter by siteKey/site, taskType, target, surface, secretKind, permission, or query; pick a matching bookmark, inspect its taxonomy/goal/health/drift/recipePath, then rehearse with browser_workflow_replay dry-run before apply=true executes the saved route. This is compact discovery, not raw Browser state; continue normal page work with browser_navigate and browser_observe when no saved workflow matches.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional text search over label, URL, aliases, goal, taxonomy, health, drift, and recipe metadata." },
                    "siteKey": { "type": "string", "description": "Optional site/domain filter such as google.com, github.com, or full URL." },
                    "taskType": { "type": "string", "description": "Optional canonical task type such as get, search, create, upload, login, register, verify, store, or update." },
                    "target": { "type": "string", "description": "Optional target slug such as api-key, file, document, email, calendar, or account." },
                    "surface": { "type": "string", "description": "Optional site surface/app slug such as ai-studio, drive, docs, calendar, console, dashboard." },
                    "permission": { "type": "string", "description": "Optional required permission filter such as vault.secret.store or cookies.accept." },
                    "secretKind": { "type": "string", "description": "Optional secret kind filter such as apiToken, password, emailCode, credential, or agentWalletBudget." },
                    "limit": { "type": "integer", "default": 20, "maximum": 100 }
                }
            }
        }),
        json!({
            "name": "browser_workflow_save",
            "description": "Save the current native ShellX Browser task as an experimental Agent workflow bookmark. It exports recent task/tab receipts through `/browser/recipes/export`, then writes a `/browser/bookmarks` row with `agentWorkflow` taxonomy so future agents can find and dry-run it with browser_workflows/browser_workflow_replay. Use after a successful repeated user-requested Browser task; do not use for one-off sensitive approval flows unless the user wants that workflow reusable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string", "description": "Human-readable workflow bookmark name." },
                    "siteKey": { "type": "string", "description": "Site/domain taxonomy such as google.com or github.com. Defaults from the current tab URL when possible." },
                    "taskType": { "type": "string", "description": "Task taxonomy such as get, search, create, upload, login, register, verify, store, or update." },
                    "target": { "type": "string", "description": "Target slug such as api-key, file, document, account, or report." },
                    "surface": { "type": "string", "description": "Optional app/surface slug such as ai-studio, drive, docs, calendar, console, or dashboard." },
                    "aliases": { "type": "string", "description": "Optional comma-separated aliases agents may search for later." },
                    "permissionsNeeded": { "type": "string", "description": "Optional comma-separated workflow permissions such as cookies.accept,vault.secret.store." },
                    "secretKinds": { "type": "string", "description": "Optional comma-separated secret kinds such as apiToken,password,emailCode." },
                    "url": { "type": "string", "description": "Optional bookmark URL. Defaults from the current Browser tab when possible." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id to export and bookmark." },
                    "taskId": { "type": "string", "description": "Optional Browser task id to export." },
                    "toolbarPinned": { "type": "boolean", "default": false },
                    "reason": { "type": "string", "description": "Short audit reason for recipe export and bookmark save." },
                    "timeoutMs": { "type": "integer", "default": 30000 }
                },
                "required": ["label", "taskType", "target"]
            }
        }),
        json!({
            "name": "browser_workflow_replay",
            "description": "Replay a saved native ShellX Browser Agent workflow recipe through `/browser/recipes/replay`. Pass either `bookmarkId` from browser_workflows or `recipePath`. A saved path must byte-for-byte match its in-session Browser export receipt; changed, copied, or unreceipted artifacts fail closed. Replay is dry-run by default so agents can rehearse and inspect planned/skipped steps, `stepResults`, and recipe `decisionPoints`; pass `apply=true` only when the user/task contract allows executing the saved route. Apply mode performs deterministic contract checks for contract audit status, expectedDomains, contractProfile, and allowedPermissions before running replayable navigation/click/wait/select/press/verify route steps through normal Browser receipts, ownership, locks, and approval gates, then updates the workflow bookmark health/drift metadata when a bookmarkId was used. Redacted inputs, Vault fills/captures, and unsupported steps are returned as skipped steps; inspect `stepResults` for compact per-step recovery context and `decisionPoints` for route/input/re-observation choices before continuing live with browser_observe. If no saved workflow fits, use browser_navigate and browser_observe for the normal live Browser flow.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "bookmarkId": { "type": "string", "description": "Workflow bookmark id returned by browser_workflows." },
                    "recipePath": { "type": "string", "description": "Absolute path to an unchanged ShellX Browser recipe JSON artifact with a matching in-session export receipt." },
                    "apply": { "type": "boolean", "default": false, "description": "When true, execute replayable saved route steps. Dry-run is the default." },
                    "dryRun": { "type": "boolean", "default": true, "description": "Explicit dry-run override. Ignored when apply=true." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id. If present, also pass the owning taskId." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "expectedDomains": { "type": "array", "items": { "type": "string" }, "description": "Optional contract scope. When present with apply=true and bookmarkId, the workflow siteKey must match one of these domains." },
                    "contractProfile": { "type": "string", "description": "Optional contract profile expected by the current user/task contract. When present with apply=true and bookmarkId, it must match the workflow contractProfile." },
                    "allowedPermissions": { "type": "array", "items": { "type": "string" }, "description": "Optional contract permissions allowed for this replay. When present with apply=true and bookmarkId, it must cover workflow permissionsNeeded." },
                    "reason": { "type": "string", "description": "Short audit reason for the replay receipt." },
                    "timeoutMs": { "type": "integer", "default": 30000 }
                }
            }
        }),
        json!({
            "name": "browser_fill_from_vault",
            "description": "Fill a native ShellX Browser field with an approved Vault grant through Debug API `/browser/action` action `fillFromVaultGrant`. Agent flow: browser_navigate if needed, browser_observe first to get refs, use vault_list to discover agent-visible secrets, ask the user/ShellX for a Fill grant, then pass `grantId`, `secretRef`, and a Browser `refId` or `selector`; the secret value is injected by ShellX and is never returned to the agent.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "secretRef"]
            }
        }),
        json!({
            "name": "browser_fill_profile_card",
            "description": "Fill one ShellX Vault profile-card field in the native Browser through Debug API `/browser/action` action `fillProfileCardGrant`. Agent flow: use vault_list to discover profileCard resources, ask for a ProfileFill grant, observe the page for a target field, then pass `grantId`, `resourceRef`, field `key` such as `email` or `address.city`, and `refId` or `selector`. ShellX extracts and injects only that field; the full profile card is never returned.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef", "key"]
            }
        }),
        json!({
            "name": "browser_capture_secret_to_vault",
            "description": "Capture a directly visible page field or text node inside native ShellX Browser and write it to ShellX Vault through `/browser/action` action `capturePageSecretToVault`. Use after creating API keys or generated credentials that appear on a page. Prefer redacted `secret-*` refs returned by browser_observe; otherwise pass `secretRef` plus a precise `refId` or `selector`. ShellX reads and stores a visible value internally and returns only a write receipt, never the secret. Copy-only controls fail closed with an explicit operator-clipboard-transfer requirement: ShellX does not click them or read the host clipboard.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["secretRef"]
            }
        }),
        json!({
            "name": "browser_read_email_code",
            "description": "Read a short login or verification code from an approved ShellX Vault emailInbox resource through Debug API `/browser/action` action `readEmailCodeGrant`. Gmail is the first tested provider; the resource model is provider-neutral for Outlook, IMAP, and future OAuth/API connectors. Returns only the code and redacted receipt metadata after an EmailCodeRead grant.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef"]
            }
        }),
        json!({
            "name": "browser_use_agent_wallet",
            "description": "Reserved agent-wallet checkout action. ShellX validates AgentWalletUse grants for stripeAgentWallet resources, but 0.3.5 returns browser_agent_wallet_checkout_unavailable until a real provider transaction bridge can prove the payment operation. Never use this for user payment cards or treat grant approval as checkout success.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef"]
            }
        }),
        json!({
            "name": "browser_wait_for",
            "description": "Wait in the native ShellX Browser through Debug API `/browser/action` with action `waitFor`. Agent flow: after browser_navigate and browser_observe, use `value` for visible text or `selector` for element waits; selector waits require the element to remain geometrically stable across multiple samples, while text-only waits stay immediate when matched. `timeoutMs` bounds the page wait and is capped by ShellX. Failures return Browser `notFound` evidence with actionability details for selector waits.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_extract",
            "description": "Extract text, markdown, or table data from the native ShellX Browser through the Debug API `/browser/action` using `extractText`, `extractMarkdown`, or `extractTable`. Agent flow: browser_navigate to the page, browser_observe when refs/context matter, then extract; pass `format: markdown` for markdown or `format: table` plus an optional selector for table extraction.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["text", "markdown", "table"], "default": "text" },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "selector": { "type": "string", "description": "Optional selector scope." },
                    "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease." },
                    "ownerAgentId": { "type": "string", "description": "Optional Browser tab lock owner agent." },
                    "ownerRunId": { "type": "string", "description": "Optional Browser tab lock owner run." }
                }
            }
        }),
        json!({
            "name": "browser_save_page",
            "description": "Save the current native ShellX Browser page as a local text or markdown artifact only when the user wants page content saved. Uses Browser extraction, writes to `destinationDir`, the Browser default download folder, or the user's OS Downloads folder, and returns the exact `finalPath`, bytes, SHA-256, MIME type, and Browser extraction receipt so agents never need to search the PC for the saved file. Do not use this for raw Browser state, observe responses, or diagnostic traces; use browser_trace_open for those.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["markdown", "text"], "default": "markdown" },
                    "fileName": { "type": "string", "description": "Optional output filename. Defaults to the page title plus .md or .txt." },
                    "destinationDir": { "type": "string", "description": "Optional absolute destination directory. Defaults to the Browser default download folder, then the user's OS Downloads folder, and is constrained to the user's home tree." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "selector": { "type": "string", "description": "Optional selector scope." },
                    "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease." },
                    "ownerAgentId": { "type": "string", "description": "Optional Browser tab lock owner agent." },
                    "ownerRunId": { "type": "string", "description": "Optional Browser tab lock owner run." },
                    "timeoutMs": { "type": "integer", "description": "Optional MCP call timeout in milliseconds. Defaults to 30000 and is clamped." }
                }
            }
        }),
        json!({
            "name": "browser_verify",
            "description": "Attach deterministic native ShellX Browser verification evidence through the Debug API `/browser/action` with action `verify`. Agent flow: browser_navigate, browser_observe, act, then browser_verify; `key` supports text, url, element, table, and schema.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["key"]
            }
        }),
        json!({
            "name": "browser_screenshot",
            "description": "Capture a native ShellX Browser screenshot through Debug API `/browser/action` with action `captureScreenshot`. Set `fullPage=true` to produce one page-content PNG for the whole document, not only the visible Browser window; full-page responses include pageWidth/pageHeight and MCP cssScale so agents can convert screenshot pixels to CSS coordinates for browser_click_at/browser_type_text. Re-capture after viewport changes and scroll off-screen targets into view before coordinate actions. Returns a local screenshot artifact path, SHA-256, dimensions, and Browser receipt metadata.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_downloads",
            "description": "Read native ShellX Browser download records through Debug API `/browser/downloads`. Completed rows include `finalPath`, bytes, SHA-256, MIME type, source URL, and retention reason; use this after user/manual saves or Browser transfer workflows instead of searching the filesystem.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "browser_resolve_dialog",
            "description": "Resolve a native ShellX Browser beforeunload dialog owned by the same Browser task through Debug API `/browser/dialogs/resolve`. Use when Browser returns `blockedBeforeUnload` for an agent-owned non-personal tab. Requires `dialogId`, `taskId`, and action `accept` or `dismiss`; personal/delegated user tabs and page permissions still require the ShellX operator UI.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dialogId": { "type": "string", "description": "Pending Browser dialog id from /browser/dialogs or a blockedBeforeUnload receipt." },
                    "taskId": { "type": "string", "description": "Owning Browser task id. Must match the pending beforeunload dialog." },
                    "action": { "type": "string", "enum": ["accept", "dismiss"], "description": "accept leaves the dirty page; dismiss stays on the current page." },
                    "timeoutMs": { "type": "integer", "description": "Optional MCP call timeout in milliseconds. Defaults to 10000 and is clamped." }
                },
                "required": ["dialogId", "taskId", "action"]
            }
        }),
        json!({
            "name": "browser_trace_open",
            "description": "Export a native ShellX Browser trace bundle through the Debug API `/browser/trace/export`. Agent flow evidence after browser_navigate/browser_observe/actions can be captured here; writes a bounded redacted artifact under ShellX trace storage and returns the exact path. Do not copy the trace or raw Browser state into the current working directory or user folders unless the user explicitly asks for an exported file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "reason": { "type": "string", "description": "Short audit reason." }
                }
            }
        }),
        json!({
            "name": "browser_evidence",
            "description": "List a bounded caller-owned view of recent Flight Recorder export and evaluation receipts. This returns artifact identity metadata only; it never embeds attempt artifact bodies or exposes another agent session's task receipts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
                }
            }
        }),
        json!({
            "name": "browser_flight_recorder_export",
            "description": "Write one bounded redacted sx.flightRecorder.v1 attempt artifact for the current caller-owned Browser task. Returns attemptId, task/tab scope, private path, bytes, SHA-256, selected/dropped counts, and a receipt. Use browser_act action=flightRecorderExport through the compact advertised gateway.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "browserTabId": { "type": "string" },
                    "suiteId": { "type": "string" },
                    "attemptIndex": { "type": "integer", "minimum": 0 },
                    "group": { "type": "string" },
                    "reason": { "type": "string" },
                    "timeoutMs": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "browser_evaluation_write",
            "description": "Write a deterministic bounded sx.evaluation.v1 report for exact caller-owned Flight Recorder artifact identities. Missing/incomplete evidence and candidate safety violations fail closed. Returns reportId, private path, bytes, SHA-256, evidence digest, rating, completeness, and receipt. Use browser_act action=evaluationWrite through the compact advertised gateway.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "suiteId": { "type": "string" },
                    "evaluatedAtMs": { "type": "integer", "minimum": 1 },
                    "taskId": { "type": "string" },
                    "baselineLabel": { "type": "string" },
                    "candidateLabel": { "type": "string" },
                    "reason": { "type": "string" },
                    "attempts": {
                        "type": "array",
                        "maxItems": 200,
                        "items": {
                            "type": "object",
                            "properties": {
                                "attemptId": { "type": "string" },
                                "group": { "type": "string", "enum": ["baseline", "candidate"] },
                                "taskId": { "type": "string" },
                                "status": { "type": "string", "enum": ["passed", "failed", "blocked", "incomplete"] },
                                "durationMs": { "type": "integer", "minimum": 0 },
                                "steps": { "type": "integer", "minimum": 0 },
                                "safetyViolations": { "type": "integer", "minimum": 0 },
                                "stuckCategory": { "type": "string" },
                                "artifactPath": { "type": "string" },
                                "artifactBytes": { "type": "integer", "minimum": 1 },
                                "artifactSha256": { "type": "string" }
                            },
                            "required": ["attemptId", "group", "taskId", "status", "artifactPath", "artifactBytes", "artifactSha256"]
                        }
                    },
                    "timeoutMs": { "type": "integer" }
                },
                "required": ["suiteId", "evaluatedAtMs", "taskId", "attempts"]
            }
        }),
    ]
}
