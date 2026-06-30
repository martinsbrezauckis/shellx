import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { assertDebugHealthVersion } from "./shellx-debug-version";
import { shellxHomeCandidates } from "./shellx-debug-paths";

type Json = Record<string, unknown>;

interface DebugHighlightResult {
  id?: string;
  selector?: string;
  status?: string;
  message?: string | null;
  rect?: { left: number; top: number; width: number; height: number } | null;
  visibleRect?: { left: number; top: number; width: number; height: number } | null;
  clipped?: boolean;
}

interface BrowserTab {
  browserTabId: string;
  taskId?: string | null;
  profileId: string;
  ownerKind?: string | null;
  url?: string | null;
  status: string;
}

interface BrowserBookmark {
  bookmarkId: string;
  label: string;
  url?: string | null;
  kind?: "link" | "folder";
  parentId?: string | null;
  toolbarPinned?: boolean;
  toolbarOrder?: number | null;
}

interface BrowserSessionGrant {
  grantId: string;
  status: string;
}

interface BrowserVaultDepositResponse {
  depositId: string;
}

interface BrowserState {
  tabs?: BrowserTab[];
  activeBrowserTabId?: string | null;
  tasks?: BrowserTask[];
  activeTaskId?: string | null;
  bookmarks?: BrowserBookmark[];
  bookmarkToolbar?: Array<{ bookmarkId: string }>;
  sessionGrants?: BrowserSessionGrant[];
  privacy?: {
    globalAdMode?: string;
    profileModes?: Array<{ profileId: string; adMode: string }>;
    updatedAtMs?: number;
  };
  shields?: {
    enabled?: boolean;
    adTrackerMode?: string;
    siteOverrides?: Array<{ host: string; adTrackerMode: string; scriptBlockingEnabled?: boolean }>;
    updatedAtMs?: number;
  };
  personalLock?: {
    enabled?: boolean;
    locked?: boolean;
    timeoutMinutes?: number;
    authMode?: string;
    pinConfigured?: boolean;
    updatedAtMs?: number;
    lockOnSleep?: boolean;
    lockOnMinimize?: boolean;
    blurLockedTabs?: boolean;
    pauseDelegatedTabsWhenLocked?: boolean;
  };
  engine?: {
    mounted: boolean;
    url?: string | null;
    loadStatus: string;
    bounds?: { x: number; y: number; width: number; height: number } | null;
  } | null;
}

interface BrowserTask {
  taskId: string;
  profileId: string;
  currentUrl?: string | null;
}

interface BrowserActionResponse {
  status: string;
  screenshot?: {
    path: string;
    bytes: number;
    sha256: string;
  };
}

const DEFAULT_URL = process.env.SHELLX_BROWSER_UI_URL?.trim() || "https://example.org/";
const EVIDENCE_ROOT = process.env.SHELLX_BROWSER_EVIDENCE_ROOT?.trim()
  || join(homedir(), ".shellx", "evidence");
const EVIDENCE_OUT = join(EVIDENCE_ROOT, "browser-ui-debug-live");

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

interface DebugConnection {
  shellxHome: string;
  base: string;
  token: string;
}

async function resolveDebugConnection(): Promise<DebugConnection> {
  const baseOverride = process.env.SHELLX_DEBUG_BASE?.trim();
  const portOverride = process.env.SHELLX_DEBUG_PORT?.trim();
  const tokenOverride = process.env.SHELLX_DEBUG_TOKEN?.trim();
  const errors: string[] = [];
  for (const dir of shellxHomeCandidates()) {
    const port = portOverride || readTrim(join(dir, "debug-api.port"));
    const token = tokenOverride || readTrim(join(dir, "shellxagent.token"));
    if (!port || !token) {
      errors.push(`${dir}: missing ${!port ? "debug-api.port" : "shellxagent.token"}`);
      continue;
    }
    const base = baseOverride || `http://127.0.0.1:${port}`;
    try {
      const res = await request(base, token, "/health");
      if (res.ok) {
        await assertDebugHealthVersion(res, dir);
        return { shellxHome: dir, base, token };
      }
      errors.push(`${dir}: /health ${res.status}`);
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`ShellX debug API is not reachable from candidate homes: ${errors.join("; ")}`);
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function api<T>(base: string, token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await request(base, token, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function apiMaybe<T>(
  base: string,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; status: number; text: string }> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await request(base, token, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, text };
  return { ok: true, value: text ? JSON.parse(text) as T : {} as T };
}

async function postUi(base: string, token: string, body: Json): Promise<void> {
  await api(base, token, "POST", "/state/ui", { debugSurface: "browser", ...body });
}

async function postAppUi(base: string, token: string, body: Json): Promise<void> {
  await api(base, token, "POST", "/state/ui", { debugSurface: "app", ...body });
}

async function postUiForbidden(base: string, token: string, body: Json): Promise<void> {
  const res = await request(base, token, "/state/ui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ debugSurface: "browser", ...body }),
  });
  const text = await res.text();
  if (res.status !== 403 || !text.includes("debug_ui_human_only_control")) {
    throw new Error(`expected /state/ui human-only denial, got ${res.status}: ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 12_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

function expectedHighlights(name: string, selectors: string[], label = name): Json[] {
  return selectors.map((selector, index) => ({
    id: `${name}-${index}`,
    selector,
    label,
    color: "cyan",
  }));
}

async function waitForHighlights(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 12_000,
  surface: "app" | "browser" = "browser",
): Promise<DebugHighlightResult[]> {
  const expectedIds = selectors.map((_, index) => `${name}-${index}`);
  let broadcastAttempt = 0;
  const broadcast = () => {
    const payload = {
      source: surface === "app" ? "app-ui-debug-smoke" : "browser-ui-debug-smoke",
      debugHighlights: expectedHighlights(name, selectors, `${name}-${broadcastAttempt++}`),
    };
    return surface === "app" ? postAppUi(base, token, payload) : postUi(base, token, payload);
  };
  await broadcast();
  let lastBroadcastMs = Date.now();
  return await waitFor(`debug highlights ${name}`, async () => {
    const ui = await api<{
      debugHighlightResults?: DebugHighlightResult[];
      debugHighlightResultsBySurface?: Record<string, DebugHighlightResult[]>;
    }>(base, token, "GET", "/state/ui");
    const surfaceResults = ui.debugHighlightResultsBySurface?.[surface];
    const results = Array.isArray(surfaceResults)
      ? surfaceResults
      : Array.isArray(ui.debugHighlightResults)
        ? ui.debugHighlightResults
        : [];
    const byId = new Map(results.map((result) => [result.id, result]));
    const missing = expectedIds.filter((id) => {
      const result = byId.get(id);
      return result?.status !== "resolved" || !result.rect || result.rect.width <= 0 || result.rect.height <= 0;
    });
    if (missing.length === 0) return results.filter((result) => expectedIds.includes(result.id ?? ""));
    if (Date.now() - lastBroadcastMs > 1_000) {
      await broadcast();
      lastBroadcastMs = Date.now();
    }
    return null;
  }, timeoutMs);
}

async function highlightsVisible(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 1_500,
): Promise<boolean> {
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights(name, selectors),
  });
  try {
    await waitForHighlights(base, token, name, selectors, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function browserPromptVisible(base: string, token: string, promptSelector: string): Promise<boolean> {
  return await highlightsVisible(base, token, `prompt-visible-${Date.now()}`, [promptSelector], 1_200);
}

function activeTab(state: BrowserState): BrowserTab | null {
  return state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId) ?? null;
}

async function ensureActiveBrowserTask(
  base: string,
  token: string,
  goal: string,
): Promise<{ state: BrowserState; task: BrowserTask; tab: BrowserTab }> {
  const current = await api<BrowserState>(base, token, "GET", "/browser/state").catch(() => null);
  const currentTab = current ? activeTab(current) : null;
  const currentTask = current?.tasks?.find((entry) => entry.taskId === current.activeTaskId)
    ?? current?.tasks?.find((entry) => entry.taskId === currentTab?.taskId)
    ?? null;
  if (current && currentTab && currentTask?.taskId && currentTab.taskId === currentTask.taskId) {
    return { state: current, task: currentTask, tab: currentTab };
  }

  await api<Json>(base, token, "POST", "/browser/open", { startUrl: DEFAULT_URL });
  const task = await api<BrowserTask>(base, token, "POST", "/browser/task/start", {
    goal,
    startUrl: DEFAULT_URL,
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
  });
  const state = await waitFor(`${goal} tab becomes active`, async () => {
    const next = await api<BrowserState>(base, token, "GET", "/browser/state");
    return activeTab(next)?.taskId === task.taskId ? next : null;
  });
  const tab = activeTab(state);
  if (!tab) throw new Error(`${goal} active tab missing after task start`);
  return { state, task, tab };
}

function highlightBottom(result: DebugHighlightResult | undefined): number | null {
  const rect = result?.visibleRect ?? result?.rect;
  if (!rect) return null;
  return rect.top + rect.height;
}

function highlightRight(result: DebugHighlightResult | undefined): number | null {
  const rect = result?.visibleRect ?? result?.rect;
  if (!rect) return null;
  return rect.left + rect.width;
}

async function waitForNativeEngineBelow(
  base: string,
  token: string,
  label: string,
  overlayBottom: number,
): Promise<void> {
  await waitFor(label, async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const bounds = state.engine?.bounds;
    if (!bounds) return null;
    return bounds.y >= overlayBottom - 4 ? state : null;
  }, 12_000, 250);
  assert(true, label);
}

async function waitForNativeEngineRightOf(
  base: string,
  token: string,
  label: string,
  sidecarRight: number,
): Promise<void> {
  await waitFor(label, async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const bounds = state.engine?.bounds;
    if (!bounds) return null;
    return bounds.x >= sidecarRight - 4 ? state : null;
  }, 12_000, 250);
  assert(true, label);
}

function normalizeUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/$/, "");
}

function toWslPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (drive?.[1] && drive[2] !== undefined) return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  return normalized;
}

function copyEvidenceScreenshot(path: string, outDir: string, label: string): string | null {
  const source = toWslPath(path);
  if (!existsSync(source)) return null;
  const dest = join(outDir, `${label}-${basename(source)}`);
  copyFileSync(source, dest);
  return dest;
}

async function captureBrowser(base: string, token: string, taskId: string, outDir: string, label: string): Promise<Json> {
  const response = await waitFor(`${label} Browser screenshot captured`, async () => {
    const result = await api<BrowserActionResponse>(base, token, "POST", "/browser/action", {
      taskId,
      action: "captureScreenshot",
    });
    return result.status === "applied" ? result : null;
  }, 12_000, 500);
  assert(response.status === "applied", `${label} Browser screenshot captured`);
  assert((response.screenshot?.bytes ?? 0) > 10_000, `${label} Browser screenshot is non-empty`);
  const copied = response.screenshot?.path ? copyEvidenceScreenshot(response.screenshot.path, outDir, label) : null;
  return {
    label,
    sourcePath: response.screenshot?.path ?? null,
    copiedPath: copied,
    bytes: response.screenshot?.bytes ?? null,
    sha256: response.screenshot?.sha256 ?? null,
  };
}

async function closeAllBrowserTabs(base: string, token: string): Promise<void> {
  const state = await api<BrowserState>(base, token, "GET", "/browser/state").catch(() => null);
  for (const tab of state?.tabs ?? []) {
    await api<Json>(base, token, "POST", "/browser/tabs/close", { browserTabId: tab.browserTabId }).catch(() => undefined);
  }
  await postUi(base, token, { source: "browser-ui-debug-smoke", debugHighlights: [] }).catch(() => undefined);
}

async function startVaultFillFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const formHtml = [
    "<!doctype html>",
    "<html><head><title>ShellX Vault Fill Smoke</title></head>",
    "<body>",
    "<main>",
    "<h1>Gmail sign in</h1>",
    "<form>",
    "<label for=\"email\">Email</label>",
    "<input id=\"email\" name=\"identifier\" type=\"email\" autocomplete=\"username\" value=\"vault-fill@example.test\" />",
    "<label for=\"password\">Password</label>",
    "<input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" aria-label=\"Gmail password\" />",
    "</form>",
    "</main>",
    "</body></html>",
  ].join("");
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(formHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address?.port) throw new Error("Vault fill fixture did not bind a local port");
  return {
    url: `http://127.0.0.1:${address.port}/gmail-login.html`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runVaultFillSuggestionSmoke(
  base: string,
  token: string,
  restoreTabId: string,
): Promise<void> {
  if (process.env.SHELLX_VAULT_E2E !== "1") {
    console.log("  - Browser Vault fill suggestion smoke skipped; set SHELLX_VAULT_E2E=1 and disposable SHELLX_VAULT_PROFILE_DIR to seed Vault entries");
    return;
  }

  const secretRef = `000-smoke/browser-ui-vault-fill-${Date.now()}`;
  const seed = await apiMaybe<{ ok: boolean; key: string }>(base, token, "POST", "/vault/set", {
    key: secretRef,
    value: "SHELLX_UI_VAULT_FILL_SENTINEL",
    description: "Gmail password for Browser UI Vault fill smoke",
    userOnly: false,
  });
  if (!seed.ok) {
    if (
      seed.status === 403 &&
      (seed.text.includes("vault_write_requires_operator") ||
        seed.text.includes("vault_e2e_profile_not_isolated"))
    ) {
      console.log("  - Browser Vault fill suggestion smoke skipped; installed app was not launched with SHELLX_VAULT_E2E=1 and disposable SHELLX_VAULT_PROFILE_DIR");
      return;
    }
    throw new Error(`POST /vault/set failed ${seed.status}: ${seed.text}`);
  }

  let openedTabId: string | null = null;
  let fixture: { url: string; close: () => Promise<void> } | null = null;
  try {
    const initialLock = (await api<BrowserState>(base, token, "GET", "/browser/state")).personalLock ?? {};
    if (initialLock.enabled === true && initialLock.locked === true) {
      if (initialLock.authMode === "pinOnly" && initialLock.pinConfigured === true) {
        throw new Error("Browser Vault fill smoke requires an unlocked personal profile; Personal Browser Lock is PIN-only and locked");
      }
      await postUi(base, token, {
        source: "browser-ui-debug-smoke",
        debugClick: "[data-debug-id='shellx-browser-personal-lock-toggle']",
      });
      await waitFor("Browser Vault fill smoke unlocks personal profile", async () => {
        const state = await api<BrowserState>(base, token, "GET", "/browser/state");
        return state.personalLock?.locked === false ? state : null;
      }, 8_000, 300);
    }

    const stateBefore = await api<BrowserState>(base, token, "GET", "/browser/state");
    if (stateBefore.personalLock?.enabled === true && stateBefore.personalLock.locked === true) {
      throw new Error("Browser Vault fill smoke requires unlocked personal tabs");
    }
    fixture = await startVaultFillFixture();
    const opened = await api<{ ok: boolean; tab: BrowserTab }>(base, token, "POST", "/browser/tabs/open", {
      profileId: "personal",
      url: fixture.url,
      expectedDomains: ["127.0.0.1"],
    });
    openedTabId = opened.tab.browserTabId;
    assert(opened.ok && Boolean(openedTabId), "Browser Vault fill smoke opens a user-owned password tab");
    assert(opened.tab.profileId === "personal" && (opened.tab.ownerKind ?? "user") === "user", "Browser Vault fill smoke tab stays personal and user-owned");
    await api<{ ok: boolean; tab: BrowserTab }>(base, token, "POST", "/browser/tabs/focus", {
      browserTabId: openedTabId,
    });
    await waitFor("Browser Vault fill smoke tab is active", async () => {
      const state = await api<BrowserState>(base, token, "GET", "/browser/state");
      return state.activeBrowserTabId === openedTabId && state.engine?.loadStatus !== "navigating" ? state : null;
    }, 15_000, 300);

    await waitForHighlights(base, token, "browser-vault-fill-ready", [
      "[data-debug-id='shellx-browser-vault-fill-badge']",
    ], 15_000);
    const vaultFillPanelSelectors = [
      "[data-debug-id='shellx-browser-vault-fill-panel']",
      "[data-debug-id='shellx-browser-vault-fill-suggestion']",
    ];
    if (!(await highlightsVisible(base, token, "browser-vault-fill-already-open", vaultFillPanelSelectors, 1_500))) {
      await postUi(base, token, {
        source: "browser-ui-debug-smoke",
        debugClick: "[data-debug-id='shellx-browser-vault-fill-menu']",
        debugHighlights: expectedHighlights("browser-vault-fill-menu", vaultFillPanelSelectors),
      });
    }
    await waitForHighlights(base, token, "browser-vault-fill-menu", vaultFillPanelSelectors, 15_000);
    assert(true, "Browser Vault fill menu renders a matching password suggestion from Vault metadata");

    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-vault-fill-suggestion']",
      debugHighlights: expectedHighlights("browser-vault-fill-trusted-click-gate", [
        ".shellx-browser-vault-fill-status",
      ]),
    });
    await waitForHighlights(base, token, "browser-vault-fill-trusted-click-gate", [
      ".shellx-browser-vault-fill-status",
    ], 10_000);
    assert(true, "Browser Vault fill suggestion refuses synthetic debug clicks and requires a trusted user click");
  } finally {
    if (openedTabId) {
      await api<Json>(base, token, "POST", "/browser/tabs/close", { browserTabId: openedTabId }).catch(() => undefined);
    }
    await api<Json>(base, token, "POST", "/browser/tabs/focus", { browserTabId: restoreTabId }).catch(() => undefined);
    await apiMaybe<{ ok: boolean }>(base, token, "POST", "/vault/delete", { key: secretRef }).catch(() => ({ ok: false, status: 0, text: "delete failed" }));
    if (fixture) await fixture.close().catch(() => undefined);
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugHighlights: [],
    }).catch(() => undefined);
  }
}

async function cleanupInstalledBrowser(): Promise<void> {
  const connection = await resolveDebugConnection().catch(() => null);
  if (!connection) return;
  await closeAllBrowserTabs(connection.base, connection.token);
}

async function main(): Promise<void> {
  const { shellxHome, base, token } = await resolveDebugConnection();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = process.env.SHELLX_BROWSER_UI_OUT ?? join(EVIDENCE_OUT, stamp);
  mkdirSync(outDir, { recursive: true });

  console.log("\n=== ShellX Browser rendered UI debug smoke ===");
  assert(true, `debug API health responds from ${shellxHome}`);

  await closeAllBrowserTabs(base, token);
  await waitFor("Browser UI smoke starts from a clean Browser tab state", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    return (state.tabs?.length ?? 0) === 0 ? state : null;
  }, 8_000, 300);

  const {
    task,
    tab: initialTab,
  } = await ensureActiveBrowserTask(base, token, "Rendered Browser chrome smoke");
  assert(Boolean(task.taskId), "Browser task started for rendered smoke");

  const firstTabId = initialTab.browserTabId;
  assert(Boolean(firstTabId), "Browser task tab is active");

  if (await highlightsVisible(base, token, "browser-right-initial-show", [
    "[data-debug-id='shellx-browser-show-right-sidebar-button']",
  ], 750)) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-show-right-sidebar-button']",
      debugHighlights: expectedHighlights("browser-right-initial-expanded", [
        "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
      ]),
    });
    await waitForHighlights(base, token, "browser-right-initial-expanded", [
      "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    ]);
  }

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-chrome", [
      "[data-debug-id='shellx-browser-address']",
      "[data-debug-id='shellx-browser-new-tab']",
      "[data-debug-id='shellx-browser-bookmarks-menu']",
      "[data-debug-id='shellx-browser-personal-lock-toggle']",
      "[data-debug-id='shellx-browser-options']",
      "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    ]),
  });
  await waitForHighlights(base, token, "browser-chrome", [
    "[data-debug-id='shellx-browser-address']",
    "[data-debug-id='shellx-browser-new-tab']",
    "[data-debug-id='shellx-browser-bookmarks-menu']",
    "[data-debug-id='shellx-browser-options']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
  ]);
  assert(true, "Browser chrome controls resolve as visible renderer elements");

  await runVaultFillSuggestionSmoke(base, token, firstTabId);

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-filter']",
    debugHighlights: expectedHighlights("browser-ad-filter-menu", [
      "[data-debug-id='shellx-browser-ad-mode-balanced']",
      "[data-debug-id='shellx-browser-ad-mode-strict']",
      "[data-debug-id='shellx-browser-ad-mode-off']",
    ]),
  });
  await waitForHighlights(base, token, "browser-ad-filter-menu", [
    "[data-debug-id='shellx-browser-ad-mode-balanced']",
    "[data-debug-id='shellx-browser-ad-mode-strict']",
    "[data-debug-id='shellx-browser-ad-mode-off']",
  ]);
  const privacyBeforeBalance = await api<BrowserState>(base, token, "GET", "/browser/state");
  const beforeBalanceAt = privacyBeforeBalance.privacy?.updatedAtMs ?? 0;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-mode-balanced']",
  });
  const balancedState = await waitFor("Browser UI balanced ad-mode command reaches Tauri", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const updatedAt = state.privacy?.updatedAtMs ?? 0;
    return updatedAt > beforeBalanceAt ? state : null;
  });
  const afterBalanceAt = balancedState.privacy?.updatedAtMs ?? beforeBalanceAt;

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-filter']",
    debugHighlights: expectedHighlights("browser-ad-filter-strict-menu", [
      "[data-debug-id='shellx-browser-ad-mode-strict']",
    ]),
  });
  await waitForHighlights(base, token, "browser-ad-filter-strict-menu", [
    "[data-debug-id='shellx-browser-ad-mode-strict']",
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-mode-strict']",
  });
  await waitFor("Browser UI ad-mode change reaches operator Tauri command", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const updatedAt = state.privacy?.updatedAtMs ?? 0;
    const hasStrictProfile = state.privacy?.profileModes?.some((item) => item.adMode === "strict");
    return updatedAt > afterBalanceAt && hasStrictProfile ? state : null;
  });
  assert(true, "Browser UI can change ad mode through the operator Tauri command");
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-filter']",
    debugHighlights: expectedHighlights("browser-ad-filter-restore-menu", [
      "[data-debug-id='shellx-browser-ad-mode-balanced']",
    ]),
  });
  await waitForHighlights(base, token, "browser-ad-filter-restore-menu", [
    "[data-debug-id='shellx-browser-ad-mode-balanced']",
  ]);
  const beforeRestoreAt = (await api<BrowserState>(base, token, "GET", "/browser/state")).privacy?.updatedAtMs ?? 0;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-ad-mode-balanced']",
  });
  await waitFor("Browser UI ad-mode restore reaches Tauri", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const updatedAt = state.privacy?.updatedAtMs ?? 0;
    return updatedAt > beforeRestoreAt ? state : null;
  });

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-trust-chip-before-shields", [
      "[data-debug-id='shellx-browser-trust-chip']",
    ]),
  });
  await waitForHighlights(base, token, "browser-trust-chip-before-shields", [
    "[data-debug-id='shellx-browser-trust-chip']",
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-trust-chip']",
    debugHighlights: expectedHighlights("browser-shields-panel", [
      "[data-debug-id='shellx-browser-shields-panel']",
      "[data-debug-id='shellx-browser-shields-global-enabled']",
      "[data-debug-id='shellx-browser-site-shields-ad-trackers']",
    ]),
  });
  await waitForHighlights(base, token, "browser-shields-panel", [
    "[data-debug-id='shellx-browser-shields-panel']",
    "[data-debug-id='shellx-browser-shields-global-enabled']",
    "[data-debug-id='shellx-browser-site-shields-ad-trackers']",
  ]);
  const shieldsBeforeToggle = await api<BrowserState>(base, token, "GET", "/browser/state");
  const activeHost = hostFromUrl(activeTab(shieldsBeforeToggle)?.url) ?? hostFromUrl(DEFAULT_URL);
  assert(Boolean(activeHost), "Browser UI smoke has an active host for Shields override");
  const shieldsBeforeToggleAt = shieldsBeforeToggle.shields?.updatedAtMs ?? 0;
  const initialShieldsEnabled = shieldsBeforeToggle.shields?.enabled !== false;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-shields-global-enabled']",
  });
  const shieldsAfterToggle = await waitFor("Browser UI global Shields command reaches Tauri", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const updatedAt = state.shields?.updatedAtMs ?? 0;
    return updatedAt > shieldsBeforeToggleAt && state.shields?.enabled === !initialShieldsEnabled ? state : null;
  });
  let siteReadyState = shieldsAfterToggle;
  if (siteReadyState.shields?.enabled !== true) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-shields-global-enabled']",
    });
    siteReadyState = await waitFor("Browser UI enables Shields before site override smoke", async () => {
      const state = await api<BrowserState>(base, token, "GET", "/browser/state");
      const updatedAt = state.shields?.updatedAtMs ?? 0;
      return updatedAt > (shieldsAfterToggle.shields?.updatedAtMs ?? shieldsBeforeToggleAt) && state.shields?.enabled === true ? state : null;
    });
  }
  if (siteReadyState.shields?.siteOverrides?.some((entry) => entry.host === activeHost)) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-site-shields-reset']",
    });
    siteReadyState = await waitFor("Browser UI clears stale site Shields override before smoke", async () => {
      const state = await api<BrowserState>(base, token, "GET", "/browser/state");
      const hasOverride = state.shields?.siteOverrides?.some((entry) => entry.host === activeHost);
      return hasOverride === false ? state : null;
    });
  }
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-site-shields-ad-trackers']",
      value: "strict",
    },
  });
  const siteOverrideState = await waitFor("Browser UI site Shields command reaches Tauri", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const item = state.shields?.siteOverrides?.find((entry) => entry.host === activeHost);
    return item?.adTrackerMode === "strict" ? state : null;
  });
  assert(Boolean(siteOverrideState.shields?.siteOverrides?.some((entry) => entry.host === activeHost && entry.adTrackerMode === "strict")), "Browser UI can save site Shields through the operator Tauri command");
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-site-shields-reset']",
  });
  await waitFor("Browser UI site Shields reset reaches Tauri", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const hasOverride = state.shields?.siteOverrides?.some((entry) => entry.host === activeHost);
    return hasOverride === false ? state : null;
  });
  assert(true, "Browser UI can reset site Shields through the operator Tauri command");
  const afterSiteReset = await api<BrowserState>(base, token, "GET", "/browser/state");
  if ((afterSiteReset.shields?.enabled !== false) !== initialShieldsEnabled) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-shields-global-enabled']",
    });
    await waitFor("Browser UI restores original global Shields setting", async () => {
      const state = await api<BrowserState>(base, token, "GET", "/browser/state");
      return (state.shields?.enabled !== false) === initialShieldsEnabled ? state : null;
    });
  }
  assert(true, "Browser UI restored global Shields before continuing");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-right-tab-chat']",
    debugHighlights: expectedHighlights("browser-agent-panel-chat", [
      "[data-debug-id='shellx-browser-agent-panel']",
    ]),
  });
  await waitForHighlights(base, token, "browser-agent-panel-chat", [
    "[data-debug-id='shellx-browser-agent-panel']",
  ]);

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-agent-bottom-controls", [
      "[data-debug-id='shellx-browser-agent-takeover']",
      "[data-debug-id='shellx-browser-agent-abort']",
    ]),
  });
  const agentBottomControlHighlights = await waitForHighlights(base, token, "browser-agent-bottom-controls", [
    "[data-debug-id='shellx-browser-agent-takeover']",
    "[data-debug-id='shellx-browser-agent-abort']",
  ]);
  assert(
    agentBottomControlHighlights.every((result) => result.clipped !== true),
    "Browser Agent bottom Abort/Takeover controls are fully visible above the app border",
  );

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    rightTab: "actions",
  });
  await waitForHighlights(base, token, "browser-actions-panel-shell", [
    "[data-debug-id='shellx-browser-right-tab-actions']",
    "[data-debug-id='shellx-browser-actions-panel']",
  ]);

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-actions-panel", [
      "[data-debug-id='shellx-browser-right-tab-actions']",
      "[data-debug-id='shellx-browser-actions-panel']",
      ".shellx-browser-receipt",
      ".shellx-browser-actions-panel .shellx-browser-receipt small",
    ]),
  });
  const actionsPanelHighlights = await waitForHighlights(base, token, "browser-actions-panel", [
    "[data-debug-id='shellx-browser-right-tab-actions']",
    "[data-debug-id='shellx-browser-actions-panel']",
    ".shellx-browser-receipt",
    ".shellx-browser-actions-panel .shellx-browser-receipt small",
  ]);
  const actionsTab = actionsPanelHighlights.find((result) => result.selector === "[data-debug-id='shellx-browser-right-tab-actions']");
  const actionsReceiptSummary = actionsPanelHighlights.find((result) => result.selector === ".shellx-browser-actions-panel .shellx-browser-receipt small");
  assert(Boolean(actionsTab?.rect && actionsTab.rect.width >= 38), "Browser Actions tab label keeps a readable rendered width");
  assert(Boolean(actionsReceiptSummary?.rect && actionsReceiptSummary.rect.width >= 80 && actionsReceiptSummary.rect.height >= 10), "Browser Actions receipt text keeps readable dimensions");
  assert(
    actionsPanelHighlights.every((result) => result.clipped !== true),
    "Browser Actions tab content renders without clipped or distorted rows",
  );

  const evidence: Json[] = [await captureBrowser(base, token, task.taskId, outDir, "01-initial")];

  const approvedGrant = await api<BrowserSessionGrant>(base, token, "POST", "/browser/session-grants/request", {
    taskId: task.taskId,
    fromProfileId: "personal",
    toProfileId: "agent-work",
    reason: "Rendered UI smoke validates Browser Vault approval prompt approve action",
    ttlSeconds: 3600,
  });
  const approvePromptCardSelector = `[data-prompt-id='session-grant-${approvedGrant.grantId}']`;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-right-tab-requests']",
    debugHighlights: expectedHighlights("browser-vault-requests-tab", [
      "[data-debug-id='shellx-browser-requests-panel']",
      approvePromptCardSelector,
    ]),
  });
  await waitForHighlights(base, token, "browser-vault-requests-tab", [
    "[data-debug-id='shellx-browser-requests-panel']",
    approvePromptCardSelector,
  ]);
  assert(true, "Browser Vault approvals render inside the Requests tab");
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-vault-prompt-approve", [
      approvePromptCardSelector,
      `${approvePromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-approveSessionGrant']`,
      `${approvePromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
    ]),
  });
  await waitForHighlights(base, token, "browser-vault-prompt-approve", [
    approvePromptCardSelector,
    `${approvePromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-approveSessionGrant']`,
    `${approvePromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
  ]);
  assert(true, "Browser Vault approval prompt card renders Approve and Deny actions");
  await postUiForbidden(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: `${approvePromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-approveSessionGrant']`,
    debugHighlights: [],
  });
  await waitFor("Browser Vault prompt approve relay remains requested", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const grant = state.sessionGrants?.find((entry) => entry.grantId === approvedGrant.grantId);
    return grant?.status === "requested" ? grant : null;
  });
  assert(true, "Browser Vault prompt approval rejects debug relay actuation");

  const deniedGrant = await api<BrowserSessionGrant>(base, token, "POST", "/browser/session-grants/request", {
    taskId: task.taskId,
    fromProfileId: "personal",
    toProfileId: "agent-work",
    reason: "Rendered UI smoke validates Browser Vault approval prompt deny action",
    ttlSeconds: 3600,
  });
  const denyPromptCardSelector = `[data-prompt-id='session-grant-${deniedGrant.grantId}']`;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-vault-prompt-deny", [
      denyPromptCardSelector,
      `${denyPromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
    ]),
  });
  await waitForHighlights(base, token, "browser-vault-prompt-deny", [
    denyPromptCardSelector,
    `${denyPromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
  ]);
  await postUiForbidden(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: `${denyPromptCardSelector} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
    debugHighlights: [],
  });
  await waitFor("Browser Vault prompt deny relay remains requested", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const grant = state.sessionGrants?.find((entry) => entry.grantId === deniedGrant.grantId);
    return grant?.status === "requested" ? grant : null;
  });
  assert(true, "Browser Vault prompt denial rejects debug relay actuation");

  const doneDeposit = await api<BrowserVaultDepositResponse>(base, token, "POST", "/browser/vault-deposits", {
    taskId: task.taskId,
    label: `Rendered UI done deposit ${Date.now()}`,
    secretValue: "sxv-ui-done-secret",
    sourceUrl: DEFAULT_URL,
  });
  const doneDepositSelector = `[data-prompt-id='vault-deposit-${doneDeposit.depositId}']`;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-vault-deposit-done", [
      doneDepositSelector,
      `${doneDepositSelector} [data-debug-id='shellx-browser-vault-prompt-dismissDeposit']`,
    ]),
  });
  await waitForHighlights(base, token, "browser-vault-deposit-done", [
    doneDepositSelector,
    `${doneDepositSelector} [data-debug-id='shellx-browser-vault-prompt-dismissDeposit']`,
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: `${doneDepositSelector} [data-debug-id='shellx-browser-vault-prompt-dismissDeposit']`,
    debugHighlights: [],
  });
  await waitFor("Browser Vault deposit Done dismisses the prompt card", async () => {
    return (await browserPromptVisible(base, token, doneDepositSelector)) ? null : { ok: true };
  }, 4_000, 500);
  assert(true, "Browser Vault deposit Done dismisses the prompt card");

  const openVaultDeposit = await api<BrowserVaultDepositResponse>(base, token, "POST", "/browser/vault-deposits", {
    taskId: task.taskId,
    label: `Rendered UI open vault deposit ${Date.now()}`,
    secretValue: "sxv-ui-open-vault-secret",
    sourceUrl: DEFAULT_URL,
  });
  const openVaultDepositSelector = `[data-prompt-id='vault-deposit-${openVaultDeposit.depositId}']`;
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-vault-deposit-open", [
      openVaultDepositSelector,
      `${openVaultDepositSelector} [data-debug-id='shellx-browser-vault-prompt-openVault']`,
    ]),
  });
  await waitForHighlights(base, token, "browser-vault-deposit-open", [
    openVaultDepositSelector,
    `${openVaultDepositSelector} [data-debug-id='shellx-browser-vault-prompt-openVault']`,
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: `${openVaultDepositSelector} [data-debug-id='shellx-browser-vault-prompt-openVault']`,
    debugHighlights: [],
  });
  await waitFor("Browser Vault deposit Open Vault dismisses the prompt card", async () => {
    return (await browserPromptVisible(base, token, openVaultDepositSelector)) ? null : { ok: true };
  }, 4_000, 500);
  assert(true, "Browser Vault deposit Open Vault dismisses the prompt card");
  await postAppUi(base, token, {
    source: "app-ui-debug-smoke",
    debugHighlights: expectedHighlights("app-vault-opened-from-browser", [
      ".vault-modal",
      "[data-debug-id='vault-filter-input']",
    ]),
  });
  await waitForHighlights(base, token, "app-vault-opened-from-browser", [
    ".vault-modal",
    "[data-debug-id='vault-filter-input']",
  ], 12_000, "app");
  assert(true, "Browser Vault prompt Open Vault opens the main app Vault panel");
  await postAppUi(base, token, {
    source: "app-ui-debug-smoke",
    openModal: "close",
    debugHighlights: [],
  }).catch(() => undefined);
  await waitFor("Browser Vault app panel closes before Browser options smoke", async () => {
    await postAppUi(base, token, {
      source: "app-ui-debug-smoke",
      openModal: "close",
      debugHighlights: [{ id: "app-vault-modal-closed", selector: ".vault-modal", label: "vault closed", color: "blue" }],
    }).catch(() => undefined);
    await sleep(120);
    const ui = await api<{
      debugHighlightResults?: DebugHighlightResult[];
      debugHighlightResultsBySurface?: Record<string, DebugHighlightResult[]>;
    }>(base, token, "GET", "/state/ui");
    const appResults = ui.debugHighlightResultsBySurface?.app ?? ui.debugHighlightResults ?? [];
    const result = appResults.find((entry) => entry.id === "app-vault-modal-closed");
    return result && result.status !== "resolved" ? { ok: true } : null;
  }, 6_000, 250);

  const optionsSelectors = [
    "[data-debug-id='shellx-browser-options-sidecar']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar']",
  ];
  if (!(await highlightsVisible(base, token, "browser-options-open", optionsSelectors))) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-options']",
      debugHighlights: expectedHighlights("browser-options", optionsSelectors),
    });
  } else {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugHighlights: expectedHighlights("browser-options", optionsSelectors),
    });
  }
  await waitForHighlights(base, token, "browser-options", optionsSelectors);
  assert(true, "Browser settings sidecar opens beside the page");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugDrag: {
      selector: "[data-debug-id='shellx-browser-color-mode']",
      dx: 0,
      dy: 0,
      steps: 1,
    },
    debugHighlights: expectedHighlights("browser-options-after-internal-pointer", optionsSelectors),
  });
  await waitForHighlights(base, token, "browser-options-after-internal-pointer", optionsSelectors);
  assert(true, "Browser settings sidecar stays open when interacting inside the panel");

  const personalLockSelectors = [
    "[data-debug-id='shellx-browser-personal-lock-enabled']",
    "[data-debug-id='shellx-browser-personal-lock-timeout']",
    "[data-debug-id='shellx-browser-personal-lock-auth-mode']",
    "[data-debug-id='shellx-browser-personal-lock-sleep']",
    "[data-debug-id='shellx-browser-personal-lock-minimize']",
  ];
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-personal-lock-controls", personalLockSelectors),
  });
  await waitForHighlights(base, token, "browser-personal-lock-controls", personalLockSelectors);
  assert(true, "Browser Personal Lock controls render in options");

  const initialPersonalLock = (await api<BrowserState>(base, token, "GET", "/browser/state")).personalLock ?? {};
  const initialPersonalLockEnabled = initialPersonalLock.enabled === true;
  const initialPersonalLockTimeout = initialPersonalLock.timeoutMinutes ?? 30;
  const initialPersonalLockAuthMode = initialPersonalLock.authMode ?? "deviceAuthPreferred";
  const alternatePersonalLockTimeout = initialPersonalLockTimeout === 5 ? 15 : 5;
  const alternatePersonalLockAuthMode = initialPersonalLockAuthMode === "pinOnly" ? "deviceAuthPreferred" : "pinOnly";

  await postUiForbidden(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-personal-lock-timeout']",
      value: String(alternatePersonalLockTimeout),
    },
  });
  const afterDebugTimeoutInput = await api<BrowserState>(base, token, "GET", "/browser/state");
  assert(
    (afterDebugTimeoutInput.personalLock?.timeoutMinutes ?? 30) === initialPersonalLockTimeout,
    "Browser Personal Lock timeout rejects debug relay input",
  );

  await postUiForbidden(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-personal-lock-auth-mode']",
      value: alternatePersonalLockAuthMode,
    },
  });
  const afterDebugAuthInput = await api<BrowserState>(base, token, "GET", "/browser/state");
  assert(
    (afterDebugAuthInput.personalLock?.authMode ?? "deviceAuthPreferred") === initialPersonalLockAuthMode,
    "Browser Personal Lock unlock method rejects debug relay input",
  );

  await postUiForbidden(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-personal-lock-enabled']",
  });
  const afterDebugEnableClick = await api<BrowserState>(base, token, "GET", "/browser/state");
  assert(
    (afterDebugEnableClick.personalLock?.enabled === true) === initialPersonalLockEnabled,
    "Browser Personal Lock enable checkbox rejects debug relay clicks",
  );
  assert(true, "Browser Personal Lock settings stay operator-only over the debug UI relay");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    debugHighlights: expectedHighlights("browser-right-restore", [
      "[data-debug-id='shellx-browser-show-right-sidebar-button']",
    ]),
  });
  await waitForHighlights(base, token, "browser-right-restore", [
    "[data-debug-id='shellx-browser-show-right-sidebar-button']",
  ]);
  assert(true, "Right-sidebar restore button remains visible in top chrome after collapse");
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "02-right-sidebar-hidden"));

  const collapsedOptionsSelectors = [
    "[data-debug-id='shellx-browser-options-sidecar']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar']",
  ];
  if (!(await highlightsVisible(base, token, "browser-options-collapsed-open", collapsedOptionsSelectors))) {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugClick: "[data-debug-id='shellx-browser-options']",
      debugHighlights: expectedHighlights("browser-options-collapsed", collapsedOptionsSelectors),
    });
  } else {
    await postUi(base, token, {
      source: "browser-ui-debug-smoke",
      debugHighlights: expectedHighlights("browser-options-collapsed", collapsedOptionsSelectors),
    });
  }
  const collapsedOptionsHighlights = await waitForHighlights(base, token, "browser-options-collapsed", [
    "[data-debug-id='shellx-browser-options-sidecar']",
    "[data-debug-id='shellx-browser-toggle-right-sidebar']",
  ]);
  const collapsedOptionsRight = highlightRight(
    collapsedOptionsHighlights.find((result) => result.selector === "[data-debug-id='shellx-browser-options-sidecar']"),
  );
  assert(collapsedOptionsRight !== null, "Collapsed-sidebar Browser settings sidecar has a measurable rectangle");
  await waitForNativeEngineRightOf(
    base,
    token,
    "Native Browser engine sits to the right of collapsed-sidebar Browser settings sidecar",
    collapsedOptionsRight ?? 0,
  );
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "03-options-sidecar-collapsed-sidebar"));

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-save-page']",
    debugHighlights: expectedHighlights("browser-save-collapsed", [
      ".shellx-browser-save-popover",
      "[data-debug-id='shellx-browser-save-media']",
    ]),
  });
  const collapsedSaveHighlights = await waitForHighlights(base, token, "browser-save-collapsed", [
    ".shellx-browser-save-popover",
    "[data-debug-id='shellx-browser-save-media']",
  ]);
  const collapsedSaveBottom = highlightBottom(
    collapsedSaveHighlights.find((result) => result.selector === ".shellx-browser-save-popover"),
  );
  assert(collapsedSaveBottom !== null, "Collapsed-sidebar Browser save menu has a measurable rectangle");
  await waitForNativeEngineBelow(
    base,
    token,
    "Native Browser engine yields to collapsed-sidebar save chrome dock",
    collapsedSaveBottom ?? 0,
  );
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "04-save-collapsed-sidebar"));

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-history-menu']",
    debugHighlights: expectedHighlights("browser-history-open", [
      "[data-debug-id='shellx-browser-history-sidecar']",
      "[data-debug-id='shellx-browser-history-user']",
      "[data-debug-id='shellx-browser-history-agent']",
      "[data-debug-id='shellx-browser-history-search']",
      "[data-debug-id='shellx-browser-history-date-filter']",
    ]),
  });
  await waitForHighlights(base, token, "browser-history-open", [
    "[data-debug-id='shellx-browser-history-sidecar']",
    "[data-debug-id='shellx-browser-history-user']",
    "[data-debug-id='shellx-browser-history-agent']",
    "[data-debug-id='shellx-browser-history-search']",
    "[data-debug-id='shellx-browser-history-date-filter']",
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-history-search']",
      value: "example",
    },
  });
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-history-date-filter']",
      value: "all",
    },
  });
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-history-agent']",
    debugHighlights: expectedHighlights("browser-history-after-scope-click", [
      "[data-debug-id='shellx-browser-history-sidecar']",
      "[data-debug-id='shellx-browser-history-user']",
      "[data-debug-id='shellx-browser-history-agent']",
      "[data-debug-id='shellx-browser-history-search']",
      "[data-debug-id='shellx-browser-history-date-filter']",
    ]),
  });
  await waitForHighlights(base, token, "browser-history-after-scope-click", [
    "[data-debug-id='shellx-browser-history-sidecar']",
    "[data-debug-id='shellx-browser-history-user']",
    "[data-debug-id='shellx-browser-history-agent']",
    "[data-debug-id='shellx-browser-history-search']",
    "[data-debug-id='shellx-browser-history-date-filter']",
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugDrag: {
      selector: "[data-debug-id='shellx-browser-history-search']",
      dx: 0,
      dy: 0,
      steps: 1,
    },
    debugHighlights: expectedHighlights("browser-history-after-pointerdown-inside", [
      "[data-debug-id='shellx-browser-history-sidecar']",
      "[data-debug-id='shellx-browser-history-user']",
      "[data-debug-id='shellx-browser-history-agent']",
      "[data-debug-id='shellx-browser-history-search']",
      "[data-debug-id='shellx-browser-history-date-filter']",
    ]),
  });
  await waitForHighlights(base, token, "browser-history-after-pointerdown-inside", [
    "[data-debug-id='shellx-browser-history-sidecar']",
    "[data-debug-id='shellx-browser-history-user']",
    "[data-debug-id='shellx-browser-history-agent']",
    "[data-debug-id='shellx-browser-history-search']",
    "[data-debug-id='shellx-browser-history-date-filter']",
  ]);
  assert(true, "Browser history sidecar supports search and date filters");
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "05-history-sidecar"));

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmarks-menu']",
  });
  await sleep(250);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugHighlights: expectedHighlights("browser-bookmarks-collapsed", [
      "[data-debug-id='shellx-browser-bookmark-manager-dock']",
      "[data-debug-id='shellx-browser-bookmark-list']",
      "[data-debug-id='shellx-browser-bookmark-list-mode']",
      "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
    ]),
  });
  const collapsedBookmarkHighlights = await waitForHighlights(base, token, "browser-bookmarks-collapsed", [
    "[data-debug-id='shellx-browser-bookmark-manager-dock']",
    "[data-debug-id='shellx-browser-bookmark-list']",
    "[data-debug-id='shellx-browser-bookmark-list-mode']",
    "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
  ]);
  const collapsedBookmarkBottom = highlightBottom(
    collapsedBookmarkHighlights.find((result) => result.selector === "[data-debug-id='shellx-browser-bookmark-manager-dock']"),
  );
  const collapsedBookmarkRight = highlightRight(
    collapsedBookmarkHighlights.find((result) => result.selector === "[data-debug-id='shellx-browser-bookmark-manager-dock']"),
  );
  assert(collapsedBookmarkBottom !== null, "Collapsed-sidebar Browser bookmark manager has a measurable rectangle");
  assert(collapsedBookmarkRight !== null, "Collapsed-sidebar Browser bookmark sidecar has a measurable right edge");
  await waitForNativeEngineRightOf(
    base,
    token,
    "Native Browser engine sits to the right of the collapsed-sidebar bookmark sidecar",
    collapsedBookmarkRight ?? 0,
  );
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "06-bookmark-sidecar-collapsed-sidebar"));

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmark-manager-close']",
    debugHighlights: [],
  });
  await sleep(250);

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-show-right-sidebar-button']",
    debugHighlights: expectedHighlights("browser-right-restored", [
      "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
      "[data-debug-id='shellx-browser-right-tab-chat']",
    ]),
  });
  await waitForHighlights(base, token, "browser-right-restored", [
    "[data-debug-id='shellx-browser-toggle-right-sidebar-button']",
    "[data-debug-id='shellx-browser-right-tab-chat']",
  ]);
  assert(true, "Right sidebar restores from top chrome");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmark-manager-close']",
    debugHighlights: [],
  });
  await sleep(250);
  assert(
    !(await highlightsVisible(base, token, "browser-bookmark-manager-initially-closed", [
      "[data-debug-id='shellx-browser-bookmark-manager-dock']",
    ], 750)),
    "Browser bookmark manager dock is closed before bookmark smoke",
  );

  const dragBookmarkAId = "ui-drag-a";
  const dragBookmarkBId = "ui-drag-b";
  const editBookmarkId = "ui-edit-link";
  const folderDropBookmarkId = "ui-folder-drop";
  const toolbarFolderId = "ui-toolbar-folder";
  const toolbarChildId = "ui-toolbar-child";
  const createdFolderLabel = "UI created no-toolbar folder";
  const createdLinkLabel = "UI created no-toolbar link";
  for (const bookmarkId of [dragBookmarkAId, dragBookmarkBId, editBookmarkId, folderDropBookmarkId, toolbarChildId, toolbarFolderId]) {
    await api<Json>(base, token, "DELETE", `/browser/bookmarks/${bookmarkId}`).catch(() => undefined);
  }
  const existingBookmarkState = await api<BrowserState>(base, token, "GET", "/browser/state");
  for (const bookmark of existingBookmarkState.bookmarks ?? []) {
    if (bookmark.label === createdFolderLabel || bookmark.label === createdLinkLabel) {
      await api<Json>(base, token, "DELETE", `/browser/bookmarks/${bookmark.bookmarkId}`).catch(() => undefined);
    }
  }
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: dragBookmarkAId,
    label: "UI drag A",
    kind: "link",
    url: "https://example.com/ui-drag-a",
    category: "debug-smoke",
    toolbarPinned: false,
    toolbarOrder: 10,
  });
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: dragBookmarkBId,
    label: "UI drag B",
    kind: "link",
    url: "https://example.com/ui-drag-b",
    category: "debug-smoke",
    toolbarPinned: false,
    toolbarOrder: 11,
  });
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: editBookmarkId,
    label: "UI edit link",
    kind: "link",
    url: "https://example.com/ui-edit-before",
    category: "debug-smoke",
    toolbarPinned: false,
    toolbarOrder: 12,
  });
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: folderDropBookmarkId,
    label: "UI folder drop",
    kind: "link",
    url: "https://example.com/ui-folder-drop",
    category: "debug-smoke",
    toolbarPinned: false,
    toolbarOrder: 13,
  });
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: toolbarFolderId,
    label: "UI toolbar folder",
    kind: "folder",
    category: "debug-smoke",
    toolbarPinned: true,
    toolbarOrder: 0,
  });
  await api<Json>(base, token, "POST", "/browser/bookmarks", {
    bookmarkId: toolbarChildId,
    label: "UI child link",
    kind: "link",
    url: "https://example.com/ui-child",
    parentId: toolbarFolderId,
    category: "debug-smoke",
    toolbarPinned: false,
    toolbarOrder: 0,
  });

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmarks-menu']",
    debugHighlights: expectedHighlights("browser-bookmarks", [
      "[data-debug-id='shellx-browser-bookmark-manager-dock']",
      "[data-debug-id='shellx-browser-bookmark-list']",
      "[data-debug-id='shellx-browser-bookmark-list-mode']",
      "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
    ]),
  });
  await waitForHighlights(base, token, "browser-bookmarks", [
    "[data-debug-id='shellx-browser-bookmark-manager-dock']",
    "[data-debug-id='shellx-browser-bookmark-list']",
    "[data-debug-id='shellx-browser-bookmark-list-mode']",
    "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
  ]);
  assert(true, "Browser bookmarks open as a compact left sidecar");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmark-manager-toggle']",
    debugHighlights: expectedHighlights("browser-bookmark-manager", [
      "[data-debug-id='shellx-browser-bookmark-manager-dock']",
      "[data-debug-id='shellx-browser-bookmark-manager']",
      "[data-debug-id='shellx-browser-bookmark-draft-label']",
      `[data-debug-id='shellx-browser-bookmark-manager-open-${toolbarFolderId}']`,
      "[data-debug-id^='shellx-browser-bookmark-label-']",
      `[data-debug-id='shellx-browser-bookmark-url-${editBookmarkId}']`,
      `[data-debug-id='shellx-browser-bookmark-drag-${dragBookmarkBId}']`,
      `[data-debug-id='shellx-browser-bookmark-manager-row-${dragBookmarkAId}']`,
      "[data-debug-id='shellx-browser-bookmark-manager-close']",
    ]),
  });
  const managerHighlights = await waitForHighlights(base, token, "browser-bookmark-manager", [
    "[data-debug-id='shellx-browser-bookmark-manager-dock']",
    "[data-debug-id='shellx-browser-bookmark-manager']",
    "[data-debug-id='shellx-browser-bookmark-draft-label']",
    `[data-debug-id='shellx-browser-bookmark-manager-open-${toolbarFolderId}']`,
    "[data-debug-id^='shellx-browser-bookmark-label-']",
    `[data-debug-id='shellx-browser-bookmark-url-${editBookmarkId}']`,
    `[data-debug-id='shellx-browser-bookmark-drag-${dragBookmarkBId}']`,
    `[data-debug-id='shellx-browser-bookmark-manager-row-${dragBookmarkAId}']`,
    "[data-debug-id='shellx-browser-bookmark-manager-close']",
  ]);
  const managerDock = managerHighlights.find((result) => result.selector === "[data-debug-id='shellx-browser-bookmark-manager-dock']");
  assert(managerDock?.clipped !== true, "Browser bookmark manager dock is not clipped by page chrome");
  assert(
    !(await highlightsVisible(base, token, "browser-bookmark-no-root-target", [
      "[data-debug-id='shellx-browser-bookmark-folder-root']",
    ], 750)),
    "Browser bookmark manager does not show a duplicate Bookmarks root drop target",
  );

  const editedUrl = "https://example.com/ui-edit-after";
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: `[data-debug-id='shellx-browser-bookmark-url-${editBookmarkId}']`,
      value: editedUrl,
      blur: true,
    },
    debugHighlights: expectedHighlights("browser-bookmark-url-edit", [
      `[data-debug-id='shellx-browser-bookmark-url-${editBookmarkId}']`,
    ]),
  });
  await waitFor("Browser bookmark manager edits an existing link URL", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const edited = state.bookmarks?.find((bookmark) => bookmark.bookmarkId === editBookmarkId);
    return edited?.url === editedUrl ? state : null;
  });
  assert(true, "Browser bookmark manager can edit an existing link URL");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugDrag: {
      selector: `[data-debug-id='shellx-browser-bookmark-drag-${folderDropBookmarkId}']`,
      dropSelector: `[data-debug-id='shellx-browser-bookmark-manager-open-${toolbarFolderId}']`,
      mode: "html-dnd",
    },
    debugHighlights: expectedHighlights("browser-bookmark-folder-row-drop", [
      `[data-debug-id='shellx-browser-bookmark-manager-open-${toolbarFolderId}']`,
      `[data-debug-id='shellx-browser-bookmark-manager-row-${folderDropBookmarkId}']`,
    ]),
  });
  await waitFor("Browser bookmark folder row accepts dropped links", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const moved = state.bookmarks?.find((bookmark) => bookmark.bookmarkId === folderDropBookmarkId);
    return moved?.parentId === toolbarFolderId ? state : null;
  });
  assert(true, "Browser bookmark folder rows accept direct drops");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugDrag: {
      selector: `[data-debug-id='shellx-browser-bookmark-drag-${dragBookmarkBId}']`,
      dx: 0,
      dy: -44,
      steps: 8,
      mode: "pointer",
    },
    debugHighlights: expectedHighlights("browser-bookmark-pointer-drag-reorder", [
      `[data-debug-id='shellx-browser-bookmark-manager-row-${dragBookmarkAId}']`,
      `[data-debug-id='shellx-browser-bookmark-manager-row-${dragBookmarkBId}']`,
    ]),
  });
  await waitFor("Browser bookmark drag reorders rows", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const a = state.bookmarks?.find((bookmark) => bookmark.bookmarkId === dragBookmarkAId);
    const b = state.bookmarks?.find((bookmark) => bookmark.bookmarkId === dragBookmarkBId);
    if (!a || !b) return null;
    const orderA = a.toolbarOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.toolbarOrder ?? Number.MAX_SAFE_INTEGER;
    return orderB < orderA ? state : null;
  });
  assert(true, "Browser bookmark pointer drag can sort rows");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-bookmark-draft-label']",
      value: createdFolderLabel,
    },
    debugHighlights: [],
  });
  await sleep(250);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[aria-label='New folder']",
    debugHighlights: expectedHighlights("browser-bookmark-create-folder", [
      "[data-debug-id='shellx-browser-bookmark-manager']",
    ]),
  });
  const createdFolderState = await waitFor("Browser created folder is not auto-pinned to toolbar", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const created = state.bookmarks?.find((bookmark) => bookmark.label === createdFolderLabel);
    if (!created) return null;
    const toolbarHasCreated = state.bookmarkToolbar?.some((item) => item.bookmarkId === created.bookmarkId) ?? false;
    return created.toolbarPinned === false && !toolbarHasCreated ? state : null;
  });
  const createdFolder = createdFolderState.bookmarks?.find((bookmark) => bookmark.label === createdFolderLabel);
  assert(Boolean(createdFolder), "Browser new folders require explicit toolbar pinning");

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-bookmark-draft-label']",
      value: createdLinkLabel,
    },
    debugHighlights: [],
  });
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-bookmark-draft-url']",
      value: "https://example.com/ui-created-link",
    },
    debugHighlights: [],
  });
  await sleep(250);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[aria-label='Add link']",
    debugHighlights: expectedHighlights("browser-bookmark-create-link", [
      "[data-debug-id='shellx-browser-bookmark-manager']",
    ]),
  });
  const createdLinkState = await waitFor("Browser created link is not auto-pinned to toolbar", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const created = state.bookmarks?.find((bookmark) => bookmark.label === createdLinkLabel);
    if (!created) return null;
    const toolbarHasCreated = state.bookmarkToolbar?.some((item) => item.bookmarkId === created.bookmarkId) ?? false;
    return created.toolbarPinned === false && !toolbarHasCreated ? state : null;
  });
  const createdLink = createdLinkState.bookmarks?.find((bookmark) => bookmark.label === createdLinkLabel);
  assert(Boolean(createdLink), "Browser new links require explicit toolbar pinning");
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "07-bookmark-manager-sidecar"));

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-bookmark-manager-close']",
    debugHighlights: [],
  });
  await sleep(250);
  assert(
    !(await highlightsVisible(base, token, "browser-bookmark-manager-closed", [
      "[data-debug-id='shellx-browser-bookmark-manager-dock']",
    ], 750)),
    "Browser bookmark manager dock closes after smoke",
  );

  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: `[data-debug-id='shellx-browser-bookmark-folder-${toolbarFolderId}']`,
    debugHighlights: expectedHighlights("browser-bookmark-toolbar-folder-open", [
      `[data-debug-id='shellx-browser-bookmark-folder-menu-${toolbarFolderId}']`,
      `[data-debug-id='shellx-browser-bookmark-folder-child-${toolbarChildId}']`,
    ]),
  });
  const folderMenuHighlights = await waitForHighlights(base, token, "browser-bookmark-toolbar-folder-open", [
    `[data-debug-id='shellx-browser-bookmark-folder-menu-${toolbarFolderId}']`,
    `[data-debug-id='shellx-browser-bookmark-folder-child-${toolbarChildId}']`,
  ]);
  const folderMenu = folderMenuHighlights.find((result) => result.selector === `[data-debug-id='shellx-browser-bookmark-folder-menu-${toolbarFolderId}']`);
  assert(folderMenu?.clipped !== true, "Browser toolbar folder menu is visible above page chrome");
  assert(true, "Browser toolbar folder click shows included bookmarks");
  evidence.push(await captureBrowser(base, token, task.taskId, outDir, "08-bookmark-toolbar-folder"));

  const cleanupBookmarkState = await api<BrowserState>(base, token, "GET", "/browser/state");
  for (const bookmark of cleanupBookmarkState.bookmarks ?? []) {
    if (bookmark.label === createdFolderLabel || bookmark.label === createdLinkLabel) {
      await api<Json>(base, token, "DELETE", `/browser/bookmarks/${bookmark.bookmarkId}`).catch(() => undefined);
    }
  }
  for (const bookmarkId of [dragBookmarkBId, dragBookmarkAId, editBookmarkId, folderDropBookmarkId, toolbarChildId, toolbarFolderId]) {
    await api<Json>(base, token, "DELETE", `/browser/bookmarks/${bookmarkId}`).catch(() => undefined);
  }

  const sourceTabState = await api<BrowserState>(base, token, "GET", "/browser/state");
  const sourceTab = activeTab(sourceTabState);
  const newTabSourceUrl = "https://example.net/?shellx-new-tab-source=1";
  if (sourceTab) {
    await api<BrowserActionResponse>(base, token, "POST", "/browser/action", {
      browserTabId: sourceTab.browserTabId,
      action: "navigate",
      url: newTabSourceUrl,
    });
    await waitFor("Browser new-tab source page becomes distinct from home/default URL", async () => {
      const state = await api<BrowserState>(base, token, "GET", "/browser/state");
      const tab = activeTab(state);
      return tab?.browserTabId === sourceTab.browserTabId && normalizeUrl(tab.url) === normalizeUrl(newTabSourceUrl)
        ? state
        : null;
    });
  }
  const beforeNewTab = await api<BrowserState>(base, token, "GET", "/browser/state");
  const beforeUrl = normalizeUrl(activeTab(beforeNewTab)?.url ?? DEFAULT_URL);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-new-tab']",
    debugHighlights: [],
  });
  const newTabState = await waitFor("Browser new tab becomes active", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const tab = activeTab(state);
    if (!tab || tab.browserTabId === firstTabId) return null;
    return state;
  });
  const newTab = activeTab(newTabState);
  assert(Boolean(newTab), "Browser new-tab click creates a new active tab");
  const settledNewTabState = await waitFor("Browser new tab reaches the configured home/default URL", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const tab = activeTab(state);
    const url = normalizeUrl(tab?.url);
    if (!tab || tab.browserTabId === firstTabId || url === beforeUrl || !/^https?:\/\//i.test(url)) return null;
    return state;
  });
  const settledNewTab = activeTab(settledNewTabState);
  const settledNewTabUrl = normalizeUrl(settledNewTab?.url);
  assert(settledNewTabUrl !== beforeUrl, "Browser new tab does not clone the previous page URL");
  assert(/^https?:\/\//i.test(settledNewTabUrl), "Browser new tab opens a configured home/default URL");

  const taskIntentGoal = "lets open google.com and search for info about best white bread in the world";
  await ensureActiveBrowserTask(base, token, "Browser Agent chat intent smoke");
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-right-tab-chat']",
    debugHighlights: expectedHighlights("browser-agent-chat-before-intent", [
      "[data-debug-id='shellx-browser-goal']",
      "[data-debug-id='shellx-browser-agent-send']",
    ]),
  });
  await waitForHighlights(base, token, "browser-agent-chat-before-intent", [
    "[data-debug-id='shellx-browser-goal']",
    "[data-debug-id='shellx-browser-agent-send']",
  ]);
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugInput: {
      selector: "[data-debug-id='shellx-browser-goal']",
      value: taskIntentGoal,
    },
  });
  await postUi(base, token, {
    source: "browser-ui-debug-smoke",
    debugClick: "[data-debug-id='shellx-browser-agent-send']",
    debugHighlights: [],
  });
  const searchTaskState = await waitFor("Browser Agent chat routes explicit Google search task", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const activeTask = state.tasks?.find((entry) => entry.taskId === state.activeTaskId) ?? null;
    const active = activeTab(state);
    const candidateUrl = normalizeUrl(activeTask?.currentUrl ?? active?.url ?? state.engine?.url);
    if (!candidateUrl.startsWith("https://www.google.com/search?")) return null;
    return candidateUrl.includes("best+white+bread") ? state : null;
  }, 20_000, 500);
  assert(
    normalizeUrl(searchTaskState.tasks?.find((entry) => entry.taskId === searchTaskState.activeTaskId)?.currentUrl ?? activeTab(searchTaskState)?.url)
      .includes("best+white+bread"),
    "Browser Agent chat opens explicit Google search tasks instead of cloning the current page",
  );

  await closeAllBrowserTabs(base, token);
  await waitFor("Browser tabs are closed", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    return (state.tabs?.length ?? 0) === 0 ? state : null;
  });
  const blankState = await waitFor("Browser engine resets after all tabs close", async () => {
    const state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const url = normalizeUrl(state.engine?.url);
    return url === "about:blank" || !state.activeBrowserTabId ? state : null;
  }, 8_000);
  assert((blankState.tabs?.length ?? 0) === 0, "Browser state has no tabs after closing all tabs");
  assert(!blankState.activeBrowserTabId, "Browser active tab is cleared after closing all tabs");

  await postUi(base, token, { source: "browser-ui-debug-smoke", debugHighlights: [] });
  const report = {
    base,
    startUrl: DEFAULT_URL,
    taskId: task.taskId,
    evidence,
    completedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "browser-ui-debug-smoke.json"), JSON.stringify(report, null, 2));
  console.log(`Browser rendered UI debug smoke passed; evidence: ${outDir}`);
}

main().catch(async (err) => {
  console.error(err);
  await cleanupInstalledBrowser().catch(() => undefined);
  process.exit(1);
});
