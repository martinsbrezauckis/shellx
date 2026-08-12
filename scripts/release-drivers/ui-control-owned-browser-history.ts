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
type BrowserReceipt = {
  kind?: string;
  evidence?: { scope?: unknown; removed?: unknown } | null;
};
type Kind = "entry" | "clear" | "all-clear-sheet" | "clear-cancel" | "all-clear-confirm";

const OWNER = "[data-debug-id='shellx-browser-history-menu']";
const PANEL = "#shellx-browser-history-sidecar[aria-labelledby='shellx-browser-history-menu']";
const USER_SCOPE = "[data-debug-id='shellx-browser-history-user']";
const AGENT_SCOPE = "[data-debug-id='shellx-browser-history-agent']";
const CLEAR = "[data-debug-id='shellx-browser-clear-history']";
const CLEAR_ALL = "[data-debug-id='shellx-browser-clear-all-history']";
const CLEAR_CONFIRMATION = "[data-debug-id='shellx-browser-history-clear-confirmation']";
const CLEAR_CANCEL = "[data-debug-id='shellx-browser-history-clear-cancel']";
const CLEAR_CONFIRM = "[data-debug-id='shellx-browser-history-clear-confirm']";
const SURFACES: Record<string, Kind> = {
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id^=\"shellx-browser-history-entry-\"]": "entry",
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-history\"]": "clear",
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-all-history\"]": "all-clear-sheet",
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-cancel\"]": "clear-cancel",
  "src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-confirm\"]": "all-clear-confirm",
};
export const OWNED_BROWSER_HISTORY_FIXTURES = [
  "ui:browser-owned-history-sidecar",
  "ui:browser-history-clear-sheet-owned-baseline",
] as const;
export const OWNED_BROWSER_HISTORY_CLEANUPS = [
  "ui:clear-owned-browser-history-abort-task-and-window-loopback",
  "ui:restore-owned-browser-history-clear-sheet",
] as const;
export const OWNED_BROWSER_HISTORY_ORACLES = [
  "ui:activation:owned-browser-history-entry-navigation",
  "ui:activation:owned-browser-history-clear",
  "ui:activation:owned-browser-history-all-clear-sheet",
  "ui:activation:owned-browser-history-clear-cancel",
  "ui:activation:owned-browser-history-all-clear-receipt",
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
  let personalTabId: string | null = null;
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
      expectedDomains: ["127.0.0.1"],
    });
    taskId = requiredString(started.taskId, "Browser history taskId");
    await navigate(connection, taskId, page.firstUrl);
    await navigate(connection, taskId, page.secondUrl);
    await waitForHistory(connection, (history) => (
      history.some((entry) => entry.taskId === taskId && entry.url === page!.firstUrl)
      && history.some((entry) => entry.taskId === taskId && entry.url === page!.secondUrl)
    ));
    if (isAllScopeKind(kind)) {
      personalTabId = await createOwnedPersonalHistory(connection, page.startUrl);
      await waitForHistory(connection, (history) => (
        history.some((entry) => isUserHistory(entry) && entry.url === page!.startUrl)
        && history.some((entry) => !isUserHistory(entry) && entry.taskId === taskId)
      ));
    }

    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(webdriver, "ShellX Browser");
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    await openHistory(webdriver);
    baselineScope = await readScope(webdriver);
    await setScope(webdriver, kind === "all-clear-sheet" || kind === "clear-cancel" ? "user" : "agent");

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
    } else if (kind === "clear") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION);
      await clickReleaseSurfaceInstalledInputElement(
        webdriver,
        await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRM),
      );
      outcome.invoke = "pass";
      await waitForHistory(connection, (history) => history.length === 0);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input opened ShellX's exact Agent-history confirmation sheet and removed every entry from the isolated owned Browser-history baseline.";
    } else if (kind === "all-clear-sheet") {
      const mixedHistory = await requireMixedHistory(connection);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_ALL);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION);
      await requireMixedHistory(connection, mixedHistory.length);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input opened the exact All-history confirmation sheet over a mixed owned User and Agent baseline without removing either history class.";
    } else if (kind === "clear-cancel") {
      const mixedHistory = await requireMixedHistory(connection);
      await openAllHistoryClearSheet(webdriver);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CANCEL);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForHistoryClearSheetClosed(webdriver);
      await requireMixedHistory(connection, mixedHistory.length);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input cancelled the exact All-history confirmation sheet and preserved the mixed owned User and Agent history baseline.";
    } else {
      const mixedHistory = await requireMixedHistory(connection);
      await openAllHistoryClearSheet(webdriver);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRM);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForHistory(connection, (history) => history.length === 0);
      await waitForReleaseSurfaceInstalledInputElement(
        webdriver,
        "[data-debug-id='shellx-browser-history-clear-status']",
      );
      await requireAllClearReceipt(connection, mixedHistory.length);
      outcome.effect = "pass";
      outcome.observedEffect = "Installed input confirmed the exact All-history sheet, removed the mixed owned User and Agent baseline, and observed the matching all-scope receipt and success status.";
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (browserWindowOpen && ownedEmptyBaseline) {
      await cleanupAttempt(cleanupErrors, async () => {
        if (await findReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION)) {
          await clickReleaseSurfaceInstalledInputElement(
            webdriver,
            await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CANCEL),
          );
          await waitForHistoryClearSheetClosed(webdriver);
        }
        const state = await readBrowserState(connection);
        if (state.history.length > 0) {
          await openHistory(webdriver);
          await setScope(webdriver, "user");
          await clickReleaseSurfaceInstalledInputElement(
            webdriver,
            await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_ALL),
          );
          await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION);
          await clickReleaseSurfaceInstalledInputElement(
            webdriver,
            await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRM),
          );
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
          {
            taskIds: [taskId!],
            tabIds: personalTabId ? [personalTabId] : [],
            label: "final surface Browser history",
          },
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

function isAllScopeKind(kind: Kind): boolean {
  return kind === "all-clear-sheet" || kind === "clear-cancel" || kind === "all-clear-confirm";
}

function isUserHistory(entry: HistoryEntry): boolean {
  return entry.profileId === "personal" && !entry.taskId?.trim();
}

async function createOwnedPersonalHistory(connection: Connection, url: string): Promise<string> {
  const opened = await apiJson(connection, "POST", "/browser/tabs/open", {
    profileId: "personal",
    url: "about:blank",
  });
  const tab = record(opened.tab, "owned Browser personal tab");
  const browserTabId = requiredString(tab.browserTabId, "owned Browser personal tab id");
  const response = await apiJson(connection, "POST", "/browser/action", {
    browserTabId,
    action: "navigate",
    url,
  });
  if (response.ok !== true || response.status !== "applied") {
    throw new Error("Browser history personal baseline navigation was not applied");
  }
  return browserTabId;
}

async function requireMixedHistory(connection: Connection, expectedCount?: number): Promise<HistoryEntry[]> {
  const state = await readBrowserState(connection);
  const user = state.history.filter(isUserHistory);
  const agent = state.history.filter((entry) => !isUserHistory(entry));
  if (user.length === 0 || agent.length === 0 || (expectedCount !== undefined && state.history.length !== expectedCount)) {
    throw new Error("owned Browser history fixture did not preserve the exact mixed User and Agent baseline");
  }
  return state.history;
}

async function openAllHistoryClearSheet(webdriver: WebDriver): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_ALL),
  );
  await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION);
}

async function waitForHistoryClearSheetClosed(webdriver: WebDriver): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await findReleaseSurfaceInstalledInputElement(webdriver, CLEAR_CONFIRMATION)) return;
    await delay(50);
  }
  throw new Error("Browser history clear confirmation sheet did not close");
}

async function requireAllClearReceipt(connection: Connection, removed: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await apiJson(connection, "GET", "/browser/receipts?limit=20");
    const receipts = Array.isArray(response.receipts) ? response.receipts as BrowserReceipt[] : [];
    if (receipts.some((receipt) => (
      receipt.kind === "browserHistoryCleared"
      && receipt.evidence?.scope === "all"
      && receipt.evidence?.removed === removed
    ))) return;
    await delay(50);
  }
  throw new Error(`Browser history did not emit the expected all-scope clear receipt for ${removed} entries`);
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
