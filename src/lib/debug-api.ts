// src/lib/debug-api.ts
//
// Thin auth-injecting wrapper around `fetch` for talking to the
// in-process debug-api server (axum, 127.0.0.1:<bound-port>; default
// 5757, with 5759/5761/5763/5765 orphan-socket fallback). All UI
// components that hit /panels, /autonomy, /preview, /state/*, /settings,
// /vault/*, /connections, /github/* etc. MUST go through this module
// so the bearer-token header is added consistently.
//
// All UI fetches must go through `api` / `apiPost` / `apiPostJson`
// so the bearer token is added consistently — raw fetch against the
// debug-api 401s silently when the auth middleware is enabled.
//
// Behaviour:
// • `getDebugToken` invokes the Tauri command `get_debug_token` on
// first call to fetch the bearer token from the Rust side
// (the same value stored at ~/.shellx/shellxagent.token; older
// installs are auto-migrated on first boot). Cached
// in module state for the lifetime of the page.
// • `api`, `apiGet`, `apiPost`, `apiPostJson` all auto-add the
// `Authorization: Bearer <token>` header AND prepend the base URL.
// • If the Tauri invoke fails (e.g. running the React app in a plain
// browser tab during dev — not inside the Tauri shell), we fall
// back to `window.__GROK_DEBUG_TOKEN__` if present, then to no
// token. The latter still works against the /health endpoint and
// also against any endpoint when `GROK_SHELL_DEBUG_SECRET` env var
// is unset (auth middleware then accepts requests without a token).
//
// Used by App.tsx, Header.tsx, LeftRail.tsx, PRCreateModal.tsx, and
// Settings.tsx. RightRail uses raw fetch for external URL previews.

import { invoke } from "@tauri-apps/api/core";

/**
 * Default port. Override at runtime: launch the Tauri app (and any
 * external driver) with `GROK_SHELL_DEBUG_PORT=<N>` so the Rust
 * server binds there. The wrapper resolves the actual bound port via
 * `invoke('get_bound_ports')` on first call and caches the URL, so
 * multiple grok-shell-derived apps (and the orphan-socket fallback
 * to 5759/5761/5763/5765) work without colliding.
 *
 * Resolution order (first non-zero wins):
 * 1. `invoke('get_bound_ports').debugApi` — the actually-bound port
 * written by the server after a successful bind. Survives the
 * 5757→5759 orphan-socket fallback (#311).
 * 2. `invoke('get_debug_port')` — the env-preferred port (5757
 * default), used when get_bound_ports hasn't completed yet.
 * 3. DEFAULT_PORT (5757) — final fallback.
 */
const DEFAULT_PORT = 5757;
const BOUND_PORT_WAIT_MS = 45_000;

let cachedBaseUrl: string | null = null;
let pendingBaseUrlFetch: Promise<string> | null = null;
let cachedPort: number | null = null;

/** exposes the resolved debug-api port for callers that
 * want to display it (e.g. footer ws:// URL). Returns the cached
 * value if `getBaseUrl` has run; otherwise DEFAULT_PORT. */
export function getDebugPortSync(): number {
  return cachedPort ?? DEFAULT_PORT;
}

/** Shape of the `get_bound_ports` Tauri command. Each field is the
 * port the corresponding server actually bound to, or null when the
 * bind hasn't completed yet. */
interface BoundPortsResponse {
  debugApi: number | null;
  mcpHttp: number | null;
}

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
}

function hasTauriInvoke(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readBoundDebugPort(): Promise<number | null> {
  try {
    const bound = await invoke<BoundPortsResponse>("get_bound_ports");
    return validPort(bound?.debugApi) ? bound.debugApi : null;
  } catch {
    return null;
  }
}

async function readPreferredDebugPort(): Promise<number | null> {
  try {
    const port = await invoke<number>("get_debug_port");
    return validPort(port) ? port : null;
  } catch {
    return null;
  }
}

async function resolveDebugPort(): Promise<number> {
  if (hasTauriInvoke()) {
    const started = Date.now();
    while (Date.now() - started < BOUND_PORT_WAIT_MS) {
      const bound = await readBoundDebugPort();
      if (bound !== null) return bound;
      await sleep(100);
    }
    const bound = await readBoundDebugPort();
    if (bound !== null) return bound;
    throw new Error("debug-api bound port was not published by the Tauri host");
  }

  return (await readBoundDebugPort()) ?? (await readPreferredDebugPort()) ?? DEFAULT_PORT;
}

async function getBaseUrl(): Promise<string> {
  if (cachedBaseUrl !== null) return cachedBaseUrl;
  if (pendingBaseUrlFetch) return pendingBaseUrlFetch;
  pendingBaseUrlFetch = (async () => {
    const p = await resolveDebugPort();
    cachedPort = p;
    cachedBaseUrl = `http://127.0.0.1:${p}`;
    return cachedBaseUrl;
  })();
  return pendingBaseUrlFetch;
}

function invalidateDebugApiBase(): void {
  cachedBaseUrl = null;
  pendingBaseUrlFetch = null;
  cachedPort = null;
}

let cachedToken: string | null = null;
let pendingTokenFetch: Promise<string> | null = null;

/**
 * Resolve the debug-api bearer token. Cached for the page lifetime.
 *
 * Resolution order:
 * 1. Module cache (set on first successful resolve).
 * 2. `invoke('get_debug_token')` — works inside Tauri shell.
 * 3. `window.__GROK_DEBUG_TOKEN__` — set by a future init_script if any.
 * 4. Empty string — caller proceeds without auth header. The middleware
 * will 401 if GROK_SHELL_DEBUG_SECRET is set, or succeed if not.
 *
 * Idempotent across concurrent callers: the second caller awaits the
 * same in-flight promise rather than firing a duplicate invoke.
 *
 * @returns the bearer token, or "" if not available.
 */
export async function getDebugToken(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  if (pendingTokenFetch) return pendingTokenFetch;
  pendingTokenFetch = (async () => {
    try {
      const t = await invoke<string>("get_debug_token");
      cachedToken = typeof t === "string" ? t : "";
    } catch {
 // Not running inside Tauri (e.g. Vite dev in plain browser, or
 // the Tauri command isn't registered for some reason). Fall back.
      const w = window as unknown as { __GROK_DEBUG_TOKEN__?: string };
      cachedToken = w.__GROK_DEBUG_TOKEN__ || "";
    }
    return cachedToken;
  })();
  return pendingTokenFetch;
}

/**
 * Force-refresh the cached token. Call this if the user rotates
 * ~/.shellx/shellxagent.token externally and the app needs to pick
 * up the new value without a window reload.
 */
export function invalidateDebugToken(): void {
  cachedToken = null;
  pendingTokenFetch = null;
}

/**
 * Low-level wrapper around `fetch` that prepends the base URL and
 * adds the `Authorization: Bearer <token>` header. Use the typed
 * helpers below (`apiGet` / `apiPostJson`) where possible.
 *
 * @param path path-only string starting with `/` (e.g. `/state/header`).
 * @param init same shape as the standard `fetch` init.
 */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  const [token, base] = await Promise.all([getDebugToken(), getBaseUrl()]);
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  try {
    return await fetch(`${base}${path}`, { ...init, headers });
  } catch (err) {
    invalidateDebugApiBase();
    const freshBase = await getBaseUrl();
    if (freshBase === base) throw err;
    return fetch(`${freshBase}${path}`, { ...init, headers });
  }
}

/**
 * GET `path` and parse the body as JSON. Throws on non-2xx.
 *
 * @typeParam T expected response shape.
 */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const r = await api(path, { method: "GET" });
  if (!r.ok) throw new Error(`apiGet ${path} → ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

/**
 * POST `path` with a JSON body and parse the response as JSON.
 * Throws on non-2xx. For void POSTs use `apiPost`.
 */
export async function apiPostJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`apiPostJson ${path} → ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

/**
 * POST `path` with a JSON body and DISCARD the response. Throws on non-2xx.
 *
 * Use this for fire-and-forget state-write endpoints (e.g. `/panels`,
 * `/autonomy`) where the server's "ok" is the only payload that matters.
 */
export async function apiPost(path: string, body: unknown): Promise<void> {
  const r = await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`apiPost ${path} → ${r.status} ${r.statusText}`);
}

/**
 * Async accessor for the resolved base URL — needed for the rare site
 * that has to construct a URL for non-fetch use (EventSource,
 * `new WebSocket(...)` for /events). Auth for those is passed as the
 * `?token=...` query param — see `/events` WebSocket handshake.
 *
 * Was a sync `const debugApiBase` exporting a fixed URL; now resolves
 * the actual port (env-configurable via GROK_SHELL_DEBUG_PORT) so the
 * value isn't stale when running side-by-side with another grok-shell
 * derivative on a different port.
 */
export function debugApiBase(): Promise<string> {
  return getBaseUrl();
}
