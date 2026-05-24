# shellX — Agent-First Protocol (HTTP + WS Surface on `127.0.0.1:<bound-port>`)

> The shellXagent HTTP+WS server binds to `127.0.0.1` on a port chosen at
> startup. The preferred port is `5757` (overridable via
> `GROK_SHELL_DEBUG_PORT`); when busy the server steps up to
> `5759`/`5761`/`5763`/`5765`. The **actually-bound** port is written
> atomically to `~/.shellx/debug-api.port` — external drivers must read
> that file rather than hard-coding `:5757`. The host MCP HTTP server
> publishes its port to `~/.shellx/mcp-http.port` the same way.

**Status:** Implementation guide plus v1.x roadmap (drafted 2026-05-17,
current route inventory refreshed 2026-05-21).
**Audience:** Any future implementer (human or agent) extending shellX's
debug API beyond what is already wired in `src-tauri/src/debug_api.rs`.
**Goal:** Make every UI surface driveable without a GUI, so the
agent-first verification loop (`pnpm drive`) can prove
behavior end-to-end.

The wired routes in `src-tauri/src/debug_api.rs` are the source of truth for
what clients can call today. Sections below that describe routes not listed in
the current implementation inventory are roadmap targets, not shipped
endpoints. Breaking changes to wired routes require bumping `X-API-Version`
major and shipping a migration shim.

## Current Implementation Inventory

These routes are wired today. All routes except `GET /health` require the
debug bearer token from `~/.shellx/shellxagent.token` or
`GROK_SHELL_DEBUG_SECRET`.

| Method | Path |
| --- | --- |
| GET | `/health`, `/events/recent`, `/events`, `/state/header`, `/state/footer`, `/state/subagents`, `/state/ui`, `/state/skills`, `/state/github`, `/state/github/items`, `/state/sessions`, `/state/marketplace_health`, `/state/session_tooling`, `/state/session_activity`, `/state/session_git`, `/state/session_git/diff`, `/screenshot`, `/settings`, `/sessions/history`, `/sessions/search`, `/sessions/history/:id`, `/sessions/:id/snippet`, `/goal/state`, `/vault/status`, `/vault/keys`, `/connections`, `/outside-connectors` |
| POST | `/connect`, `/prompt`, `/abort`, `/disconnect`, `/autonomy`, `/state/ui`, `/panels`, `/preview`, `/tools/fs_watch`, `/tools/process_list`, `/tools/process_signal`, `/tools/process_stats`, `/tools/process_attach_stdout`, `/tools/secret_get`, `/settings`, `/sessions/:id/archive`, `/tabs/:id/archive`, `/plan`, `/goal/start`, `/goal/stop`, `/goal/complete`, `/goal/pause`, `/goal/resume`, `/goal/approve`, `/goal/reject`, `/permissions/:reqId/respond`, `/diagnostics`, `/github/pr/create`, `/vault/get`, `/vault/set`, `/vault/delete`, `/connections`, `/connections/:id/test`, `/outside-connectors`, `/outside-connectors/:id/test` |
| DELETE | `/connections/:id`, `/outside-connectors/:id` |

Not currently wired despite older roadmap text below: `GET /`, `GET /version`,
`GET /state/projects`, `GET /state/files`, `GET /state/preview`,
`GET /state/plan`, `GET /state/panels`, `GET /sessions`, `POST /sessions`,
`GET /sessions/:id`, `DELETE /sessions/:id`, `POST /sessions/:id/switch`,
`POST /sessions/:id/rename`, `GET /autonomy`, `GET /skills`,
`POST /skills/*`, `GET /files`, `POST /files/*`, and `/terminal/*`.

This document does not contain runnable code. It defines what each
endpoint accepts, what it returns, and what gets logged.

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
| `bad_gateway` | 502 | Downstream tool (grok agent, git, gh, expo) failed |
| `timeout` | 504 | Downstream call exceeded deadline |

The existing handlers return string error bodies on 500. Those are
grandfathered as v1.0 but new endpoints **must** use the structured
shape. A v1.1 migration sweep will retrofit `/connect`, `/prompt`,
`/abort` to the structured shape with the old string as
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
  payload: unknown;    // arbitrary JSON; usually the parsed JSON-RPC
                       // frame from grok agent
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
accepts a partial patch, mainly for tab control surfaces.

```ts
{
  panels: { horizontal: [number, number, number]; vertical: [number, number] };
  preview: unknown | null;
  autonomy: string | null;
  bottomTab: string | null;
  leftTab: string | null;
  rightTab: "Tasks" | "Tooling" | "Plan" | "Files" | null;
}
```

The wired detail variants are `GET /state/skills`, `GET /state/github`,
and `GET /state/github/items`. `GET /state/projects` and
`GET /state/files` remain roadmap routes. RightRail writes
`rightTab` here when the user selects Tasks, Tooling, Plan, or Files.

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
    detectedMaxContextLength: number | null;
  }>;
}
```

Note: the legacy `{ sessions, activeSessionId }` shape predated the
multi-tab refactor (#178/#284) and is no longer emitted. External
drivers should read from `tabs[].tabId` / `tabs[].sessionId` and
treat the first tab whose `hasActiveChild=true` as the user's
focused session (or read `/state/header` for the active tab).

### 3.7 `GET /state/skills`, `GET /state/github`, `GET /state/github/items`

Detail-rich snapshots of each domain. Each mirrors what the UI tab
would render. Schemas omitted for brevity — they expand the
corresponding sub-objects in §3.4 with per-row metadata (paths,
tool counts, PR titles, etc.). Implementers must add typed examples to
a fixture under `tests/` so the driver can pin them.

### 3.8 `GET /state/session_tooling?tabId=<tab>`

Read-only mirror of the right-rail Tooling tab. It returns the active
tab transport/session metadata, global MCP desired state, and the
environment-specific health rows last produced for that tab. It does
not create missing sessions or start probes; `/connect` schedules probes
for live debug-api sessions.

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

### 3.9 `GET /state/session_activity?tabId=<tab>`

Read-only source payload for the Activity Browser. The response exposes
the local evidence ShellX can currently inspect: Grok's
`hunk_records.jsonl` for verified file hunks plus a filtered
`updates.jsonl` subset containing only tool-call records. Local and WSL
sessions resolve to the user's reachable `~/.grok/sessions/...` folder.
SSH sessions return `remote-not-mirrored` until ShellX mirrors remote
trace artifacts locally.

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
}
```

### 3.10 `GET /state/files?path=<rel>` *(roadmap, not wired)*

File tree rooted at the active session's cwd, or at `path` if given
(must be **inside** cwd; otherwise `403 forbidden`).

```ts
{
  root: string;
  entries: Array<{
    path: string;          // relative to root
    kind: "file" | "dir";
    sizeBytes?: number;
    gitState?: "modified" | "untracked" | "deleted" | "staged" | "clean";
    modifiedMs?: number;
  }>;
}
```

### 3.10 `GET /state/preview`, `GET /state/plan`, `GET /state/panels`

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
**Error 502 `bad_gateway`:** grok agent failed to spawn — body includes
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

Tear down a session: abort if running, kill grok child, optionally
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

Sets the autonomy mode. Passes through to grok agent as `--permission-mode` on
next spawn. For a running session the response includes
`appliesAfterReconnect: true` because the CLI flag is already baked into argv.

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

Open a file or URL in the right Preview pane.

```ts
{
  // Exactly one of:
  path?: string;        // resolved relative to active session cwd
  url?: string;         // must match allowlist regex (http://127.0.0.1*, https://*)
  // Optional:
  kind?: "code" | "markdown" | "image" | "pdf" | "diff" | "html" | "expo";
  // Auto-detected by extension if omitted.
}
```

**Errors:** `bad_request` if both/neither given; `forbidden` if path
escapes cwd; `not_found` if path missing.

### 8.2 `GET /preview`

Returns the current preview target (see §3.9).

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

Outside connectors are user-facing channels such as Telegram bots and
local relay bridges for WhatsApp/Discord. Secrets are never posted to
these routes; connector bodies contain Vault key references only.

```ts
type OutsideConnector = {
  id: string;
  label: string;
  enabled: boolean;
  provider:
    | { kind: "telegram"; botTokenVaultKey: string; allowedChatIds: string[] }
    | { kind: "generic_relay"; sharedSecretVaultKey: string; allowedSenderIds: string[] };
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
- `POST /outside-connectors` with `OutsideConnector` → saved connector
- `DELETE /outside-connectors/:id`
- `POST /outside-connectors/:id/test` → `{ reachable, provider, latencyMs, identity, error }`

Telegram test calls Bot API `getMe` using the token stored at
`botTokenVaultKey`. Generic relay test verifies the shared-secret
vault key exists and is non-empty.

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
exercise the same primitives the grok agent uses. They live under
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
{ taskId: string; signal: "TERM" | "KILL" | "INT" | "HUP" }
```

Refuses to signal PIDs not in the registry — the safety boundary the
registry exists to provide.

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
{ path: string }              // e.g. "meshy/api-key"
```

**Response 200:** `{ value: string }` (the resolved secret, in-memory only).

**Logging:** request body logs as `{ path: "<redacted>" }`. Response
body **never logged at all** — even body bytes count is suppressed.
The path itself is treated as sensitive because it leaks intent.

Audit trail: every successful call writes a single entry to
`~/.shellx/audit.log` with `{ tMs, path, callerOrigin }` — never
the value. Failures log `{ tMs, path, reason }`.

**Future auth gate:** §11 shared-secret will gate this endpoint first
when introduced.

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
roadmap notes, not shipped endpoints. `/goal/*` is the shipped long-horizon
approval surface.

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

Mismatch returns `401 unauthorized`. The WS upgrade reads the token
from a query param `?token=<>` (browsers don't support custom headers
on WS) AND from the `Sec-WebSocket-Protocol` subprotocol fallback for
non-browser clients that prefer the header form.

Token resolution order on the server side:
1. `GROK_SHELL_DEBUG_SECRET` env var (overrides the file, used for CI)
2. `~/.shellx/shellxagent.token` (auto-created, 32 hex chars, `0600`)

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

The grok agent's stderr is already pipelined into the events firehose
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
