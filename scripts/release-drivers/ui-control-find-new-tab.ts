import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiSessionFixture,
  prepareDebugApiSessionFixture,
  type DebugApiSessionFixture,
} from "./debug-api-session-fixture";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type UiTab = Record<string, unknown> & { tabId: string };
type UiState = Record<string, unknown> & {
  activeTabId?: unknown;
  openTabs?: unknown;
};

const SURFACE = "src/components/FindPopover.tsx:[title=\"Open this chat in a new tab (Enter)\"]";
const INPUT = "[data-debug-id='find-sessions-input']";
const DISK_ROW = "[data-debug-id='surface-components-findpopover-4']";
const DISK_ROW_SELECTED = `${DISK_ROW}[aria-selected='true']`;
const PREVIEW = ".find-preview";
const POPOVER = ".find-popover";
const OPEN = "[title='Open this chat in a new tab (Enter)']";
const SHELL = ".shell";

export const FIND_NEW_TAB_FIXTURES = ["ui:find-owned-session-new-tab"] as const;
export const FIND_NEW_TAB_CLEANUPS = [
  "ui:close-owned-session-tab-delete-history-and-restore-baseline",
] as const;
export const FIND_NEW_TAB_ORACLES = ["ui:activation:find-owned-session-new-tab"] as const;

export function supportsFindNewTabControl(assignment: Assignment): boolean {
  return assignment.surface.name === SURFACE;
}

export async function exerciseFindNewTabControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let fixture: DebugApiSessionFixture | null = null;
  let baselineTabs: UiTab[] = [];
  let baselineActiveId = "";
  let ownedTabId = "";
  try {
    if (!supportsFindNewTabControl(assignment)) {
      throw new Error(`Find new-tab driver does not support ${assignment.surface.name}`);
    }
    fixture = prepareDebugApiSessionFixture(request, "ui_find_new_tab");
    const ownedFixture = fixture;
    const baseline = await uiState(connection);
    baselineTabs = exactTabs(baseline, "Find new-tab baseline");
    baselineActiveId = exactActiveId(baseline, baselineTabs, "Find new-tab baseline");
    if (baselineTabs.some((tab) => tab.sessionId === ownedFixture.id)) {
      throw new Error("owned Find session already existed in the renderer baseline");
    }

    await postUi(connection, { refreshPastChats: true });
    const shell = await waitForReleaseSurfaceInstalledInputElement(webdriver, SHELL);
    await clickReleaseSurfaceInstalledInputElement(webdriver, shell);
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, POPOVER);
    const input = await waitForReleaseSurfaceInstalledInputElement(webdriver, INPUT);
    await clearReleaseSurfaceInstalledInputElement(webdriver, input);
    await setReleaseSurfaceInstalledInputElementValue(webdriver, input, ownedFixture.marker);
    const row = await waitForReleaseSurfaceInstalledInputElement(webdriver, DISK_ROW, {
      timeoutMs: 10_000,
      pollMs: 100,
    });
    await clickReleaseSurfaceInstalledInputElement(webdriver, row);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, DISK_ROW_SELECTED);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, PREVIEW);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, OPEN);
    outcome.present = "pass";

    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, POPOVER);
    const opened = await waitForUiState(connection, (state) => {
      const tabs = safeTabs(state);
      const owned = tabs.filter((tab) => tab.sessionId === ownedFixture.id);
      return tabs.length === baselineTabs.length + 1
        && baselineTabs.every((tab, index) => tabs[index]?.tabId === tab.tabId)
        && owned.length === 1
        && state.activeTabId === owned[0]?.tabId;
    }, "owned Find session tab activation");
    const openedTabs = exactTabs(opened, "Find new-tab opened state");
    const owned = openedTabs.filter((tab) => tab.sessionId === ownedFixture.id);
    if (owned.length !== 1 || !owned[0] || baselineTabs.some((tab) => tab.tabId === owned[0]!.tabId)) {
      throw new Error("Find new-tab activation did not create one unique owned renderer tab");
    }
    ownedTabId = owned[0].tabId;
    if (openedTabs.length !== baselineTabs.length + 1
      || openedTabs.at(-1)?.tabId !== ownedTabId
      || opened.activeTabId !== ownedTabId) {
      throw new Error("Find new-tab activation did not preserve the exact tab count, append order, and active identity");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver activation opened exactly one new renderer tab for the owned on-disk session, preserved every baseline tab, and selected the exact new tab identity.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupError = await cleanup(
      connection,
      webdriver,
      fixture,
      baselineTabs,
      baselineActiveId,
      ownedTabId,
    );
    if (cleanupError) {
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
    } else {
      outcome.cleanup = "pass";
    }
  }
  return finalize(outcome);
}

async function cleanup(
  connection: Connection,
  webdriver: WebDriver,
  fixture: DebugApiSessionFixture | null,
  baselineTabs: UiTab[],
  baselineActiveId: string,
  observedOwnedTabId: string,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const input = await findReleaseSurfaceInstalledInputElement(webdriver, INPUT);
    if (input) await clearReleaseSurfaceInstalledInputElement(webdriver, input);
    const shell = await waitForReleaseSurfaceInstalledInputElement(webdriver, SHELL);
    await clickReleaseSurfaceInstalledInputElement(webdriver, shell);
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, POPOVER);

    if (fixture) {
      const current = await uiState(connection);
      const ownedIds = safeTabs(current)
        .filter((tab) => tab.sessionId === fixture.id)
        .map((tab) => tab.tabId);
      if (observedOwnedTabId && ownedIds.length > 0 && !ownedIds.includes(observedOwnedTabId)) {
        throw new Error("owned Find session identity changed before cleanup");
      }
      for (const tabId of [...new Set(ownedIds)].reverse()) {
        const closeSelector = ownedCloseSelector(tabId);
        const close = await waitForReleaseSurfaceInstalledInputElement(webdriver, closeSelector);
        await clickReleaseSurfaceInstalledInputElement(webdriver, close);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, closeSelector);
      }
    }

    if (baselineTabs.length > 0 && baselineActiveId) {
      const afterClose = await uiState(connection);
      if (afterClose.activeTabId !== baselineActiveId) {
        const baselineTab = await waitForReleaseSurfaceInstalledInputElement(
          webdriver,
          tabSelector(baselineActiveId),
        );
        await clickReleaseSurfaceInstalledInputElement(webdriver, baselineTab);
      }
      await waitForUiState(connection, (state) => {
        const ids = safeTabs(state).map((tab) => tab.tabId);
        return ids.length === baselineTabs.length
          && ids.every((id, index) => id === baselineTabs[index]?.tabId)
          && state.activeTabId === baselineActiveId;
      }, "Find new-tab exact baseline restoration");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (fixture) {
    const fixtureError = cleanupDebugApiSessionFixture(fixture);
    if (fixtureError) errors.push(fixtureError);
    try {
      await postUi(connection, { refreshPastChats: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function exactTabs(state: UiState, label: string): UiTab[] {
  const tabs = safeTabs(state);
  if (!Array.isArray(state.openTabs) || tabs.length !== state.openTabs.length || tabs.length === 0) {
    throw new Error(`${label} did not expose a nonempty exact openTabs array`);
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) {
    throw new Error(`${label} contained duplicate tab identities`);
  }
  return tabs;
}

function safeTabs(state: UiState): UiTab[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const tab = value as Record<string, unknown>;
    return typeof tab.tabId === "string" && tab.tabId ? [tab as UiTab] : [];
  });
}

function exactActiveId(state: UiState, tabs: UiTab[], label: string): string {
  const active = typeof state.activeTabId === "string" ? state.activeTabId : "";
  if (!active || !tabs.some((tab) => tab.tabId === active)) {
    throw new Error(`${label} did not bind activeTabId to one exact open tab`);
  }
  return active;
}

async function waitForUiState(
  connection: Connection,
  predicate: (state: UiState) => boolean,
  label: string,
): Promise<UiState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function uiState(connection: Connection): Promise<UiState> {
  return apiJson<UiState>(connection, "GET", "/state/ui");
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-find-new-tab",
    ...body,
  });
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function tabSelector(tabId: string): string {
  assertSafeTabId(tabId);
  return `[data-tab-id='${tabId}']`;
}

function ownedCloseSelector(tabId: string): string {
  return `${tabSelector(tabId)} [aria-label='Close session']`;
}

function assertSafeTabId(tabId: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tabId)) {
    throw new Error("owned renderer tab identity is not safe for an exact selector");
  }
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
    observedEffect: "No native owned Find session-tab lifecycle was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Find new-tab control did not satisfy every required verdict";
  }
  return outcome;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
