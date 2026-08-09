import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
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
type VisibleAdMode = "balanced" | "strict" | "off";
type Action = VisibleAdMode | "default";

const OWNER = "[data-debug-id='shellx-browser-ad-filter']";
const PANEL = "#shellx-browser-ad-filter-menu[aria-labelledby='shellx-browser-ad-filter']";
const PROFILE_ID = "task-disposable";
const SURFACES: Record<string, Action> = {
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-ad-mode-default\"]": "default",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-ad-mode-balanced\"]": "balanced",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-ad-mode-strict\"]": "strict",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-ad-mode-off\"]": "off",
};
const SELECTORS: Record<Action, string> = {
  default: "[data-debug-id='shellx-browser-ad-mode-default']",
  balanced: "[data-debug-id='shellx-browser-ad-mode-balanced']",
  strict: "[data-debug-id='shellx-browser-ad-mode-strict']",
  off: "[data-debug-id='shellx-browser-ad-mode-off']",
};

export const BROWSER_AD_MODE_FIXTURES = ["ui:browser-ad-mode-owned-task-default"] as const;
export const BROWSER_AD_MODE_CLEANUPS = ["ui:restore-browser-ad-mode-default-abort-task-and-window"] as const;
export const BROWSER_AD_MODE_ORACLES = [] as const;

export function supportsBrowserAdModeControl(assignment: Assignment): boolean {
  return assignment.surface.name in SURFACES;
}

export async function exerciseBrowserAdModeControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = SURFACES[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  try {
    if (!action) throw new Error(`Browser ad-mode driver does not support ${assignment.surface.name}`);
    const baseline = await readAdModeState(connection, null);
    if (baseline.override !== null) throw new Error(`${PROFILE_ID} ad mode did not start on its global default`);
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface Browser ad mode ${action} proof`,
      profileId: PROFILE_ID,
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(started.taskId, "Browser ad-mode taskId");
    await waitForAdModeState(connection, taskId, null, baseline.global);
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;

    if (action === "default") {
      await openMenu(webdriver);
      await clickReleaseSurfaceInstalledInputElement(
        webdriver,
        await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS.strict),
      );
      await waitForAdModeState(connection, taskId, "strict", "strict");
    }

    await openMenu(webdriver);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS[action]);
    const before = await observeReleaseSurfaceInstalledInputElement(webdriver, SELECTORS[action], ["pressed", "disabled"]);
    if (!before.present || !before.visible || typeof before.pressed !== "boolean" || typeof before.disabled !== "boolean") {
      throw new Error(`Browser ad-mode ${action} control omitted its pressed or disabled state`);
    }
    if (action === "default" ? before.disabled : before.disabled || before.pressed) {
      throw new Error(`Browser ad-mode ${action} control did not start from its exact opposite baseline`);
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const expectedOverride = action === "default" ? null : action;
    const expectedEffective = action === "default" ? baseline.global : action;
    await waitForAdModeState(connection, taskId, expectedOverride, expectedEffective);
    await openMenu(webdriver);
    await waitForPressed(webdriver, SELECTORS[action], true);
    outcome.effect = "pass";
    outcome.observedEffect = action === "default"
      ? `Native WebDriver input removed only the ${PROFILE_ID} ad-mode override and restored ${baseline.global} from the global Browser default in profile, tab, and engine state.`
      : `Native WebDriver input set only the ${PROFILE_ID} profile to ${action} in profile, tab, and engine state.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const state = await readAdModeState(connection, taskId);
        if (state.override !== null) {
          await openMenu(webdriver);
          const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS.default);
          await clickReleaseSurfaceInstalledInputElement(webdriver, control);
          await waitForAdModeState(connection, taskId!, null, state.global);
        }
      });
    }
    if (browserWindowOpen) await cleanupAttempt(cleanupErrors, async () => closeMenu(webdriver));
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds: [taskId!], label: "final surface Browser ad mode" },
        );
        if (result.errors.length > 0) throw new Error(result.errors.join("; "));
      });
    }
    if (browserWindowOpen && originalWindow) {
      await cleanupAttempt(cleanupErrors, async () => {
        await closeReleaseSurfaceInstalledInputWindow(webdriver);
        await switchReleaseSurfaceInstalledInputWindow(webdriver, originalWindow!);
      });
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join(" | ")}`;
  }
  return finalize(outcome);
}

async function openMenu(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  const owner = await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER);
  await clickReleaseSurfaceInstalledInputElement(webdriver, owner);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PANEL);
}

async function closeMenu(webdriver: WebDriver): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER),
  );
}

async function waitForPressed(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["pressed", "disabled"]);
    if (observed.present && observed.visible && observed.pressed === expected) return;
    await delay(50);
  }
  throw new Error(`Browser ad-mode control ${selector} did not reach pressed=${expected}`);
}

async function readAdModeState(
  connection: Connection,
  taskId: string | null,
): Promise<{ global: VisibleAdMode; override: VisibleAdMode | null; tab: VisibleAdMode | null; engine: VisibleAdMode | null }> {
  const state = record(await apiJson(connection, "GET", "/browser/state"), "Browser state");
  const privacy = record(state.privacy, "Browser privacy");
  const global = visibleMode(privacy.globalAdMode, "Browser privacy.globalAdMode");
  const profileModes = Array.isArray(privacy.profileModes) ? privacy.profileModes : [];
  const profile = profileModes
    .map((value) => record(value, "Browser profile ad mode"))
    .find((value) => value.profileId === PROFILE_ID);
  const override = profile ? visibleMode(profile.adMode, "Browser profile ad mode.adMode") : null;
  if (!taskId) return { global, override, tab: null, engine: null };
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const tab = tabs.map((value) => record(value, "Browser tab")).find((value) => value.taskId === taskId);
  const engine = record(state.engine, "Browser engine");
  return {
    global,
    override,
    tab: tab ? visibleMode(tab.privacyMode, "Browser tab.privacyMode") : null,
    engine: visibleMode(engine.privacyMode, "Browser engine.privacyMode"),
  };
}

async function waitForAdModeState(
  connection: Connection,
  taskId: string,
  expectedOverride: VisibleAdMode | null,
  expectedEffective: VisibleAdMode,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readAdModeState(connection, taskId);
    if (state.override === expectedOverride && state.tab === expectedEffective && state.engine === expectedEffective) return;
    await delay(50);
  }
  throw new Error(`Browser profile ${PROFILE_ID} did not reach override=${expectedOverride ?? "default"} effective=${expectedEffective}`);
}

function visibleMode(value: unknown, label: string): VisibleAdMode {
  if (value === "strict" || value === "off") return value;
  if (value === "balanced" || value === "visualClean") return "balanced";
  throw new Error(`${label} is invalid`);
}

async function apiJson(connection: Connection, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  return record(JSON.parse(text), `${method} ${path}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
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
    observedEffect: "No native Browser profile ad-mode transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if (outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass") return outcome;
  outcome.observedEffect = "Requested effect was not fully verified; private failure details were not retained.";
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { errors.push(errorText(error)); }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
