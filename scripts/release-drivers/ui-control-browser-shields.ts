import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type ShieldAdMode = "off" | "balanced" | "strict";
type ShieldCookieMode = "allowAll" | "blockThirdParty" | "blockAll";
type ShieldFingerprintMode = "compatibility" | "strict";
type SiteOverride = {
  host: string;
  adTrackerMode: ShieldAdMode;
  cookieMode: ShieldCookieMode;
  fingerprintingMode: ShieldFingerprintMode;
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
};
type Shields = SiteOverride & {
  enabled: boolean;
  siteOverrides: SiteOverride[];
};
type ActiveShields = {
  host: string | null;
  enabled: boolean;
  effectiveAdTrackerMode: ShieldAdMode;
  effectiveCookieMode: ShieldCookieMode;
  effectiveFingerprintingMode: ShieldFingerprintMode;
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  hasSiteOverride: boolean;
};
type Action =
  | "global-enabled"
  | "ad-trackers"
  | "cookies"
  | "fingerprinting"
  | "https-upgrade"
  | "script-blocking"
  | "save-site"
  | "reset-site";

const HOST = "127.0.0.1";
const OWNER = "[data-debug-id='shellx-browser-trust-chip']";
const PANEL = "#shellx-browser-shields-panel[aria-labelledby='shellx-browser-trust-chip']";
const RESET = "[data-debug-id='shellx-browser-site-shields-reset']";
const SAVE = "[data-debug-id='shellx-browser-site-shields-save']";
const SURFACES: Record<string, Action> = {
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-shields-global-enabled\"]": "global-enabled",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-ad-trackers\"]": "ad-trackers",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"surface-browser-components-browsershieldspanel-3\"]": "cookies",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"surface-browser-components-browsershieldspanel-4\"]": "fingerprinting",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"surface-browser-components-browsershieldspanel-5\"]": "https-upgrade",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-script-blocking\"]": "script-blocking",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-save\"]": "save-site",
  "src/browser/components/BrowserShieldsPanel.tsx:[data-debug-id=\"shellx-browser-site-shields-reset\"]": "reset-site",
};
const SELECTORS: Record<Action, string> = {
  "global-enabled": "[data-debug-id='shellx-browser-shields-global-enabled']",
  "ad-trackers": "[data-debug-id='shellx-browser-site-shields-ad-trackers']",
  cookies: "[data-debug-id='surface-browser-components-browsershieldspanel-3']",
  fingerprinting: "[data-debug-id='surface-browser-components-browsershieldspanel-4']",
  "https-upgrade": "[data-debug-id='surface-browser-components-browsershieldspanel-5']",
  "script-blocking": "[data-debug-id='shellx-browser-site-shields-script-blocking']",
  "save-site": SAVE,
  "reset-site": RESET,
};

export const BROWSER_SHIELDS_FIXTURES = [
  "ui:browser-shields-owned-task",
] as const;
export const BROWSER_SHIELDS_CLEANUPS = [
  "ui:reset-owned-site-shields-restore-global-abort-task-and-window",
] as const;
export const BROWSER_SHIELDS_ORACLES = [
  "ui:activation:browser-site-shields-override-transition",
] as const;

export function supportsBrowserShieldsControl(assignment: Assignment): boolean {
  return assignment.surface.name in SURFACES;
}

export async function exerciseBrowserShieldsControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = SURFACES[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let page: Awaited<ReturnType<typeof startOwnedPage>> | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let baselineEnabled: boolean | null = null;
  try {
    if (!action) throw new Error(`Browser Shields driver does not support ${assignment.surface.name}`);
    const baseline = await readShields(connection);
    baselineEnabled = baseline.enabled;
    if (baseline.siteOverrides.some((item) => item.host === HOST)) {
      throw new Error(`owned Browser Shields loopback namespace ${HOST} is not clean`);
    }
    page = await startOwnedPage();
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface Browser Shields ${action} proof`,
      startUrl: page.url,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      expectedDomains: [HOST],
    });
    taskId = requiredString(started.taskId, "Browser Shields taskId");
    await waitForActiveShields(connection, taskId, (state) => state.host === HOST);
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await ensurePanelOpen(webdriver);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS[action], {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";

    if (action === "global-enabled") {
      const target = !baseline.enabled;
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForGlobalEnabled(connection, webdriver, target);
      outcome.observedEffect = `Native WebDriver input changed the global Browser protection switch to ${target ? "enabled" : "disabled"} in both bounded rendered and Browser API state.`;
    } else if (action === "ad-trackers") {
      const current = await waitForActiveShields(connection, taskId, () => true);
      const target: ShieldAdMode = current.effectiveAdTrackerMode === "strict" ? "balanced" : "strict";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, titleForAdMode(target));
      outcome.invoke = "pass";
      await waitForSiteChoice(connection, webdriver, taskId, action, target);
      outcome.observedEffect = `Native WebDriver selection created the owned loopback site override with ${target} ad and tracker protection.`;
    } else if (action === "cookies") {
      const current = await waitForActiveShields(connection, taskId, () => true);
      const target: ShieldCookieMode = current.effectiveCookieMode === "blockAll" ? "allowAll" : "blockAll";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, titleForCookieMode(target));
      outcome.invoke = "pass";
      await waitForSiteChoice(connection, webdriver, taskId, action, target);
      outcome.observedEffect = `Native WebDriver selection created the owned loopback site override with ${target} cookie handling.`;
    } else if (action === "fingerprinting") {
      const current = await waitForActiveShields(connection, taskId, () => true);
      const target: ShieldFingerprintMode = current.effectiveFingerprintingMode === "strict" ? "compatibility" : "strict";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, titleForFingerprintMode(target));
      outcome.invoke = "pass";
      await waitForSiteChoice(connection, webdriver, taskId, action, target);
      outcome.observedEffect = `Native WebDriver selection created the owned loopback site override with ${target} fingerprinting protection.`;
    } else if (action === "https-upgrade" || action === "script-blocking") {
      const current = await waitForActiveShields(connection, taskId, () => true);
      const target = action === "https-upgrade" ? !current.httpsUpgradeEnabled : !current.scriptBlockingEnabled;
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForSiteToggle(connection, webdriver, taskId, action, target);
      outcome.observedEffect = `Native WebDriver input created the owned loopback site override with ${action} ${target ? "enabled" : "disabled"}.`;
    } else if (action === "save-site") {
      await assertButtonEnabled(webdriver, SAVE);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForActiveShields(connection, taskId, (state) => state.hasSiteOverride);
      await assertButtonEnabled(webdriver, RESET);
      outcome.observedEffect = "Native WebDriver input saved one owned loopback site override and enabled its exact Reset action.";
    } else {
      await assertButtonEnabled(webdriver, SAVE);
      const save = await waitForReleaseSurfaceInstalledInputElement(webdriver, SAVE);
      await clickReleaseSurfaceInstalledInputElement(webdriver, save);
      await waitForActiveShields(connection, taskId, (state) => state.hasSiteOverride);
      await assertButtonEnabled(webdriver, RESET);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForActiveShields(connection, taskId, (state) => !state.hasSiteOverride);
      await assertButtonDisabled(webdriver, RESET);
      outcome.observedEffect = "Native WebDriver input removed the deliberately prepared owned loopback site override and disabled Reset again.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (browserWindowOpen && taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const active = await waitForActiveShields(connection, taskId!, () => true);
        if (active.hasSiteOverride) {
          await ensurePanelOpen(webdriver);
          await assertButtonEnabled(webdriver, RESET);
          const reset = await waitForReleaseSurfaceInstalledInputElement(webdriver, RESET);
          await clickReleaseSurfaceInstalledInputElement(webdriver, reset);
          await waitForActiveShields(connection, taskId!, (state) => !state.hasSiteOverride);
        }
      });
    }
    if (browserWindowOpen && baselineEnabled !== null) {
      await cleanupAttempt(cleanupErrors, async () => {
        const current = await readShields(connection);
        if (current.enabled !== baselineEnabled) {
          await ensurePanelOpen(webdriver);
          const global = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS["global-enabled"]);
          await clickReleaseSurfaceInstalledInputElement(webdriver, global);
        }
        await waitForGlobalEnabled(connection, webdriver, baselineEnabled!);
      });
    }
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          {
            taskIds: [taskId!],
            label: "final surface Browser Shields",
          },
        );
        if (result.errors.length > 0) {
          throw new Error(`Browser Shields cleanup reported: ${result.errors.join("; ")}`);
        }
      });
    }
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceInstalledInputWindow(webdriver);
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow!);
      });
    }
    if (page) await cleanupAttempt(cleanupErrors, page.close);
    await cleanupAttempt(cleanupErrors, async () => {
      const shields = await readShields(connection);
      if (shields.siteOverrides.some((item) => item.host === HOST)) {
        throw new Error(`owned Browser Shields override for ${HOST} remained after cleanup`);
      }
      if (baselineEnabled !== null && shields.enabled !== baselineEnabled) {
        throw new Error("global Browser protection did not return to its baseline");
      }
    });
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, `cleanup: ${cleanupErrors.join(" | ")}`);
  }
  return finalize(outcome);
}

async function ensurePanelOpen(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  const owner = await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER, { timeoutMs: 5_000, pollMs: 50 });
  await clickReleaseSurfaceInstalledInputElement(webdriver, owner);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PANEL, { timeoutMs: 5_000, pollMs: 50 });
}

async function waitForGlobalEnabled(connection: Connection, webdriver: WebDriver, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const shields = await readShields(connection);
    const rendered = await observeReleaseSurfaceInstalledInputElement(webdriver, SELECTORS["global-enabled"], ["checked"]);
    if (shields.enabled === expected && rendered.present && rendered.visible && rendered.checked === expected) return;
    await delay(50);
  }
  throw new Error(`global Browser protection did not reach ${expected}`);
}

async function waitForSiteChoice(
  connection: Connection,
  webdriver: WebDriver,
  taskId: string,
  action: "ad-trackers" | "cookies" | "fingerprinting",
  expected: string,
): Promise<void> {
  const field = action === "ad-trackers"
    ? "effectiveAdTrackerMode"
    : action === "cookies" ? "effectiveCookieMode" : "effectiveFingerprintingMode";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const active = await activeShieldsForTask(connection, taskId);
    const rendered = await observeReleaseSurfaceInstalledInputElement(webdriver, SELECTORS[action], ["value"]);
    if (active?.hasSiteOverride && active[field] === expected
      && rendered.present && rendered.visible && rendered.value === expected) return;
    await delay(50);
  }
  throw new Error(`${action} did not reach ${expected} in rendered and Browser API state`);
}

async function waitForSiteToggle(
  connection: Connection,
  webdriver: WebDriver,
  taskId: string,
  action: "https-upgrade" | "script-blocking",
  expected: boolean,
): Promise<void> {
  const field = action === "https-upgrade" ? "httpsUpgradeEnabled" : "scriptBlockingEnabled";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const active = await activeShieldsForTask(connection, taskId);
    const rendered = await observeReleaseSurfaceInstalledInputElement(webdriver, SELECTORS[action], ["checked"]);
    if (active?.hasSiteOverride && active[field] === expected
      && rendered.present && rendered.visible && rendered.checked === expected) return;
    await delay(50);
  }
  throw new Error(`${action} did not reach ${expected} in rendered and Browser API state`);
}

async function assertButtonEnabled(webdriver: WebDriver, selector: string): Promise<void> {
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["disabled"]);
  if (!observed.present || !observed.visible || observed.disabled !== false) {
    throw new Error(`${selector} was not visibly enabled`);
  }
}

async function assertButtonDisabled(webdriver: WebDriver, selector: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["disabled"]);
    if (observed.present && observed.visible && observed.disabled === true) return;
    await delay(50);
  }
  throw new Error(`${selector} did not become visibly disabled`);
}

async function readShields(connection: Connection): Promise<Shields> {
  const body = await apiJson(connection, "GET", "/browser/shields");
  const value = record(body.shields, "browser shields");
  const siteOverrides = Array.isArray(value.siteOverrides)
    ? value.siteOverrides.map((item) => siteOverride(item))
    : [];
  return {
    enabled: requiredBoolean(value.enabled, "browser shields.enabled"),
    host: "",
    adTrackerMode: shieldAdMode(value.adTrackerMode, "browser shields.adTrackerMode"),
    cookieMode: shieldCookieMode(value.cookieMode, "browser shields.cookieMode"),
    fingerprintingMode: shieldFingerprintMode(value.fingerprintingMode, "browser shields.fingerprintingMode"),
    httpsUpgradeEnabled: requiredBoolean(value.httpsUpgradeEnabled, "browser shields.httpsUpgradeEnabled"),
    scriptBlockingEnabled: requiredBoolean(value.scriptBlockingEnabled, "browser shields.scriptBlockingEnabled"),
    siteOverrides,
  };
}

async function activeShieldsForTask(connection: Connection, taskId: string): Promise<ActiveShields | null> {
  const body = await apiJson(connection, "GET", "/browser/state");
  const tabs = Array.isArray(body.tabs) ? body.tabs : [];
  const tab = tabs
    .map((item) => record(item, "browser tab"))
    .find((item) => item.taskId === taskId && item.active === true)
    ?? tabs.map((item) => record(item, "browser tab")).find((item) => item.taskId === taskId);
  if (!tab || !tab.shields) return null;
  const value = record(tab.shields, "active Browser tab shields");
  return {
    host: typeof value.host === "string" ? value.host : null,
    enabled: requiredBoolean(value.enabled, "active shields.enabled"),
    effectiveAdTrackerMode: shieldAdMode(value.effectiveAdTrackerMode, "active shields.effectiveAdTrackerMode"),
    effectiveCookieMode: shieldCookieMode(value.effectiveCookieMode, "active shields.effectiveCookieMode"),
    effectiveFingerprintingMode: shieldFingerprintMode(value.effectiveFingerprintingMode, "active shields.effectiveFingerprintingMode"),
    httpsUpgradeEnabled: requiredBoolean(value.httpsUpgradeEnabled, "active shields.httpsUpgradeEnabled"),
    scriptBlockingEnabled: requiredBoolean(value.scriptBlockingEnabled, "active shields.scriptBlockingEnabled"),
    hasSiteOverride: requiredBoolean(value.hasSiteOverride, "active shields.hasSiteOverride"),
  };
}

async function waitForActiveShields(
  connection: Connection,
  taskId: string,
  predicate: (state: ActiveShields) => boolean,
): Promise<ActiveShields> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await activeShieldsForTask(connection, taskId);
    if (state && predicate(state)) return state;
    await delay(75);
  }
  throw new Error("owned Browser task did not expose its expected Shields state");
}

async function startOwnedPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || path !== "/shields") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>ShellX release Shields</title><main>Owned Browser Shields fixture ready</main>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser Shields fixture did not bind");
  return {
    url: `http://${HOST}:${address.port}/shields`,
    close: () => closeServer(server, sockets),
  };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return record(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function siteOverride(value: unknown): SiteOverride {
  const item = record(value, "site override");
  return {
    host: requiredString(item.host, "site override.host"),
    adTrackerMode: shieldAdMode(item.adTrackerMode, "site override.adTrackerMode"),
    cookieMode: shieldCookieMode(item.cookieMode, "site override.cookieMode"),
    fingerprintingMode: shieldFingerprintMode(item.fingerprintingMode, "site override.fingerprintingMode"),
    httpsUpgradeEnabled: requiredBoolean(item.httpsUpgradeEnabled, "site override.httpsUpgradeEnabled"),
    scriptBlockingEnabled: requiredBoolean(item.scriptBlockingEnabled, "site override.scriptBlockingEnabled"),
  };
}

function shieldAdMode(value: unknown, label: string): ShieldAdMode {
  if (value === "off" || value === "balanced" || value === "strict") return value;
  throw new Error(`${label} is invalid`);
}

function shieldCookieMode(value: unknown, label: string): ShieldCookieMode {
  if (value === "allowAll" || value === "blockThirdParty" || value === "blockAll") return value;
  throw new Error(`${label} is invalid`);
}

function shieldFingerprintMode(value: unknown, label: string): ShieldFingerprintMode {
  if (value === "compatibility" || value === "strict") return value;
  throw new Error(`${label} is invalid`);
}

function titleForAdMode(mode: ShieldAdMode): string {
  return mode === "balanced" ? "Balanced" : mode === "strict" ? "Strict" : "Off";
}

function titleForCookieMode(mode: ShieldCookieMode): string {
  return mode === "blockThirdParty" ? "Block third-party" : mode === "blockAll" ? "Block all" : "Allow all";
}

function titleForFingerprintMode(mode: ShieldFingerprintMode): string {
  return mode === "strict" ? "Strict" : "Compatibility";
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is missing`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No deterministic Browser Shields state transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Browser Shields control did not satisfy every required verdict";
  }
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorText(error));
  }
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
