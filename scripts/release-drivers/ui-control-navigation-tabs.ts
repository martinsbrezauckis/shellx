import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const settingsControls = {
  "[data-debug-id=\"settings-tab-general\"]": "general",
  "[data-debug-id=\"settings-tab-vault\"]": "vault",
  "[data-debug-id=\"settings-tab-connections\"]": "connections",
  "[data-debug-id=\"settings-tab-connectors\"]": "connectors",
  "[data-debug-id=\"settings-tab-desktop\"]": "desktop",
  "[data-debug-id=\"settings-tab-shellxagent\"]": "shellxagent",
  "[data-debug-id=\"settings-tab-data\"]": "data",
  "[data-debug-id=\"settings-tab-about\"]": "about",
} as const;

const rightRailControls = {
  "[data-debug-id=\"right-tab-tasks\"]": "Tasks",
  "[data-debug-id=\"right-tab-tooling\"]": "Tooling",
  "[data-debug-id=\"right-tab-git\"]": "Git",
  "[data-debug-id=\"right-tab-preview\"]": "Preview",
  "[data-debug-id=\"right-tab-plan\"]": "Plan",
  "[data-debug-id=\"right-tab-files\"]": "Files",
} as const;

type SettingsTab = typeof settingsControls[keyof typeof settingsControls];
type RightRailTab = typeof rightRailControls[keyof typeof rightRailControls];

export const NAVIGATION_TAB_FIXTURES = [
  "ui:settings-tab-opposite-baseline",
  "ui:right-rail-tab-opposite-baseline",
] as const;
export const NAVIGATION_TAB_CLEANUPS = [
  "ui:restore-settings-tab-baseline-and-close",
  "ui:restore-right-rail-tab-baseline",
] as const;
export const NAVIGATION_TAB_ORACLES = ["ui:selection-state-transition"] as const;

export function supportsNavigationTabControl(assignment: Assignment): boolean {
  const selector = assignment.surface.selector ?? "";
  return selector in settingsControls || selector in rightRailControls;
}

export async function exerciseNavigationTabControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  if (selector in settingsControls) {
    return exerciseSettingsTab(connection, installedInput, assignment, selector);
  }
  if (selector in rightRailControls) {
    return exerciseRightRailTab(connection, installedInput, assignment, selector);
  }
  throw new Error(`navigation-tab driver does not support ${assignment.surface.name}`);
}

async function exerciseSettingsTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  selector: string,
): Promise<ReleaseSurfaceDriverOutcome> {
  const target = settingsControls[selector as keyof typeof settingsControls];
  const baseline: SettingsTab = target === "general" ? "about" : "general";
  const outcome = emptyOutcome(assignment, "No native Settings-tab effect was observed.");
  try {
    if (assignment.fixtureId !== "ui:settings-tab-opposite-baseline") {
      throw new Error(`Settings-tab fixture does not match ${assignment.surface.name}`);
    }
    await postUi(connection, { openModal: "settings", source: "final-surface-navigation-tab-driver" });
    await waitForReleaseSurfaceInstalledInputElement(installedInput, "[role='dialog'][aria-label='Settings']");
    await clickTab(installedInput, selectorForSettingsTab(baseline));
    await waitForSettingsTab(installedInput, baseline, "Settings-tab setup");

    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await waitForSettingsTab(installedInput, target, "Settings-tab native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native click changed the selected Settings owner and visible tabpanel from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await clickTab(installedInput, selectorForSettingsTab(baseline));
      await waitForSettingsTab(installedInput, baseline, "Settings-tab cleanup baseline");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-navigation-tab-cleanup" });
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, "[role='dialog'][aria-label='Settings']");
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, cleanupErrors.join("; "));
  }
  return finalizeOutcome(outcome);
}

async function exerciseRightRailTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  selector: string,
): Promise<ReleaseSurfaceDriverOutcome> {
  const target = rightRailControls[selector as keyof typeof rightRailControls];
  const baseline: RightRailTab = target === "Tasks" ? "Files" : "Tasks";
  const outcome = emptyOutcome(assignment, "No native right-rail tab effect was observed.");
  try {
    if (assignment.fixtureId !== "ui:right-rail-tab-opposite-baseline") {
      throw new Error(`right-rail fixture does not match ${assignment.surface.name}`);
    }
    await setRightRailTab(connection, installedInput, baseline, "right-rail setup");
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await waitForRightRailTab(connection, installedInput, target, "right-rail native effect");
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native click synchronized the visible selected right-rail owner and Debug API state from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await setRightRailTab(connection, installedInput, baseline, "right-rail cleanup");
      outcome.cleanup = "pass";
    } catch (error) {
      outcome.error = appendError(outcome.error, error instanceof Error ? error.message : String(error));
    }
  }
  return finalizeOutcome(outcome);
}

async function clickTab(installedInput: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, webdriverSelector(selector));
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
}

async function waitForSettingsTab(
  installedInput: ReleaseSurfaceInstalledInputSession,
  tab: SettingsTab,
  label: string,
): Promise<void> {
  try {
    await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `${webdriverSelector(selectorForSettingsTab(tab))}[aria-selected='true']`,
    );
    await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `#settings-tab-panel[aria-labelledby='settings-tab-${tab}']`,
    );
  } catch (error) {
    throw new Error(`${label} did not select ${tab}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function setRightRailTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  tab: RightRailTab,
  label: string,
): Promise<void> {
  await postUi(connection, {
    debugSurface: "app",
    source: "final-surface-navigation-tab-driver",
    openModal: "close",
    debugHighlights: [],
    rightTab: tab,
  });
  await waitForRightRailTab(connection, installedInput, tab, label);
}

async function waitForRightRailTab(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  tab: RightRailTab,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
      await waitForReleaseSurfaceInstalledInputElement(
        installedInput,
        `${webdriverSelector(selectorForRightRailTab(tab))}.active[aria-selected='true']`,
        { timeoutMs: 500, pollMs: 50 },
      );
      if (state.rightTab === tab) return;
    } catch {
      // Debug state and the visible React selection may settle on adjacent turns.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not reach ${tab} in Debug API and selected owner state`);
}

function selectorForSettingsTab(tab: SettingsTab): string {
  const entry = Object.entries(settingsControls).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no Settings-tab selector exists for ${tab}`);
  return entry[0];
}

function selectorForRightRailTab(tab: RightRailTab): string {
  const entry = Object.entries(rightRailControls).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no right-rail tab selector exists for ${tab}`);
  return entry[0];
}

function emptyOutcome(assignment: Assignment, observedEffect: string): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect,
  };
}

function finalizeOutcome(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "navigation tab did not satisfy every required verdict";
  }
  return outcome;
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; cleanup: ${detail}` : `cleanup: ${detail}`;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

async function apiJson<T = unknown>(
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
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  return await response.json() as T;
}

function webdriverSelector(inventorySelector: string): string {
  return inventorySelector.replaceAll('"', "'");
}
