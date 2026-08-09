import {
  acceptReleaseSurfaceInstalledInputAlert,
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
import { startOwnedBrowserHomePage, type OwnedBrowserHomePage } from "./ui-control-owned-browser-bookmarks";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type HistoryEntry = {
  historyId: string;
  taskId?: string | null;
  profileId: string;
  url: string;
};
type BrowserTab = { browserTabId: string; taskId?: string | null; url?: string | null };
type Kind = "entry" | "clear";

const OWNER = "[data-debug-id='shellx-browser-history-menu']";
const PANEL = "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']";
const USER_SCOPE = "[data-debug-id='shellx-browser-history-user']";
const AGENT_SCOPE = "[data-debug-id='shellx-browser-history-agent']";
const CLEAR = "[data-debug-id='shellx-browser-clear-history']";
const CLEAR_CONFIRMATION = "Clear browser history?";
const SURFACES: Record<string, Kind> = {
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id^=\"shellx-browser-history-entry-\"]": "entry",
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-history\"]": "clear",
};
export const OWNED_BROWSER_HISTORY_FIXTURES = ["ui:browser-owned-history-sidecar"] as const;
export const OWNED_BROWSER_HISTORY_CLEANUPS = ["ui:clear-owned-browser-history-abort-task-and-window-loopback"] as const;
export const OWNED_BROWSER_HISTORY_ORACLES = [
  "ui:activation:owned-browser-history-entry-navigation",
  "ui:activation:owned-browser-history-clear",
] as const;

export function supportsOwnedBrowserHistoryControl(assignment: Assignment): boolean {
  return assignment.surface.name in SURFACES;
}

export async function exerciseOwnedBrowserHistoryControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const kind = SURFACES[assignment.surface.name];
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let page: OwnedBrowserHomePage | null = null;
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let baselineScope: "user" | "agent" | null = null;
  let ownedEmptyBaseline = false;
  try {
    if (!kind) throw new Error(`owned Browser history driver does not support ${assignment.surface.name}`);
    const baseline = await readBrowserState(connection);
    if (baseline.history.length !== 0) {
      throw new Error("owned Browser history fixture requires an isolated empty history baseline");
    }
    ownedEmptyBaseline = true;
    page = await startOwnedBrowserHomePage();
    const started = await apiJson(connection, "POST", "/browser/task/start", {
      goal: `Final surface Browser history ${kind} proof`,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: page.startUrl,
    });
    taskId = requiredString(started.taskId, "Browser history taskId");
    await navigate(connection, taskId, page.firstUrl);
    await navigate(connection, taskId, page.secondUrl);
    await waitForHistory(connection, (history) => (
      history.some((entry) => entry.taskId === taskId && entry.url === page!.firstUrl)
      && history.some((entry) => entry.taskId === taskId && entry.url === page!.secondUrl)
    ));

    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await openHistory(webdriver);
    baselineScope = await readScope(webdriver);
    await setScope(webdriver, "agent");

    if (kind === "entry") {
      const state = await readBrowserState(connection);
      const entry = state.history.find((candidate) => candidate.taskId === taskId && candidate.url === page!.firstUrl);
      if (!entry) throw new Error("owned Browser history entry disappeared before native input");
      const selector = `[data-debug-id='shellx-browser-history-entry-${entry.historyId}']`;
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForTaskUrl(connection, taskId, page.firstUrl);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input selected the exact owned Agent-history row and navigated its task tab to the recorded loopback URL.";
    } else {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      await acceptReleaseSurfaceInstalledInputAlert(webdriver, CLEAR_CONFIRMATION);
      outcome.invoke = "pass";
      await waitForHistory(connection, (history) => history.length === 0);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input accepted the exact operator confirmation and removed every entry from the isolated owned Browser-history baseline.";
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (browserWindowOpen && ownedEmptyBaseline) {
      await cleanupAttempt(cleanupErrors, async () => {
        const state = await readBrowserState(connection);
        if (state.history.length > 0) {
          await openHistory(webdriver);
          await setScope(webdriver, "agent");
          await clickReleaseSurfaceInstalledInputElement(
            webdriver,
            await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR),
          );
          await acceptReleaseSurfaceInstalledInputAlert(webdriver, CLEAR_CONFIRMATION);
          await waitForHistory(connection, (history) => history.length === 0);
        }
        if (!await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) await openHistory(webdriver);
        if (baselineScope) await setScope(webdriver, baselineScope);
        await closeHistory(webdriver);
      });
    }
    if (taskId) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds: [taskId!], label: "final surface Browser history" },
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
    if (page) await cleanupAttempt(cleanupErrors, page.close);
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupErrors.join(" | ")}`;
  }
  return finalize(outcome);
}

async function navigate(connection: Connection, taskId: string, url: string): Promise<void> {
  const response = await apiJson(connection, "POST", "/browser/action", { taskId, action: "navigate", url });
  if (response.ok !== true || response.status !== "applied") throw new Error(`Browser history navigation to ${url} was not applied`);
}

async function openHistory(webdriver: WebDriver): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER));
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PANEL);
}

async function closeHistory(webdriver: WebDriver): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(webdriver, PANEL)) return;
  await clickReleaseSurfaceInstalledInputElement(webdriver, await waitForReleaseSurfaceInstalledInputElement(webdriver, OWNER));
}

async function readScope(webdriver: WebDriver): Promise<"user" | "agent"> {
  const [user, agent] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, USER_SCOPE, ["pressed"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, AGENT_SCOPE, ["pressed"]),
  ]);
  if (user.present && user.visible && agent.present && agent.visible
    && user.pressed === true && agent.pressed === false) return "user";
  if (user.present && user.visible && agent.present && agent.visible
    && user.pressed === false && agent.pressed === true) return "agent";
  throw new Error("Browser history scope did not expose one exact active choice");
}

async function setScope(webdriver: WebDriver, scope: "user" | "agent"): Promise<void> {
  if (await readScope(webdriver) === scope) return;
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, scope === "user" ? USER_SCOPE : AGENT_SCOPE),
  );
  if (await readScope(webdriver) !== scope) throw new Error(`Browser history scope did not change to ${scope}`);
}

async function readBrowserState(connection: Connection): Promise<{ history: HistoryEntry[]; tabs: BrowserTab[] }> {
  const state = await apiJson(connection, "GET", "/browser/state");
  return {
    history: Array.isArray(state.history) ? state.history.map((value) => record(value, "Browser history entry") as HistoryEntry) : [],
    tabs: Array.isArray(state.tabs) ? state.tabs.map((value) => record(value, "Browser tab") as BrowserTab) : [],
  };
}

async function waitForHistory(connection: Connection, predicate: (history: HistoryEntry[]) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate((await readBrowserState(connection)).history)) return;
    await delay(50);
  }
  throw new Error("Browser history did not reach the required owned state");
}

async function waitForTaskUrl(connection: Connection, taskId: string, url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readBrowserState(connection);
    if (state.tabs.some((tab) => tab.taskId === taskId && tab.url === url)
      && state.history[0]?.taskId === taskId && state.history[0]?.url === url) return;
    await delay(50);
  }
  throw new Error(`Browser task did not navigate to owned history URL ${url}`);
}

async function apiJson(connection: Connection, method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    observedEffect: "No native owned Browser-history transition was observed.",
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
