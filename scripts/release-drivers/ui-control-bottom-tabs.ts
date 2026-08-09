import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const controls = {
  "[data-debug-id=\"bottom-tab-chat\"]": "Chat",
  "[data-debug-id=\"bottom-tab-terminal\"]": "Terminal",
  "[data-debug-id=\"bottom-tab-images\"]": "Images",
  "[data-debug-id=\"bottom-tab-videos\"]": "Videos",
  "[data-debug-id=\"bottom-tab-logs\"]": "Logs",
  "[data-debug-id=\"bottom-tab-stderr\"]": "Stderr",
} as const;

type BottomTab = typeof controls[keyof typeof controls];

export const BOTTOM_TAB_FIXTURES = ["ui:bottom-tab-opposite-baseline"] as const;
export const BOTTOM_TAB_CLEANUPS = ["ui:restore-bottom-tab-baseline"] as const;
export const BOTTOM_TAB_ORACLES = [
  "ui:activation:bottom-tab-chat-state-transition",
  "ui:activation:bottom-tab-terminal-state-transition",
  "ui:activation:bottom-tab-images-state-transition",
  "ui:activation:bottom-tab-videos-state-transition",
  "ui:activation:bottom-tab-logs-state-transition",
  "ui:activation:bottom-tab-stderr-state-transition",
] as const;

export function supportsBottomTabControl(assignment: Assignment): boolean {
  return (assignment.surface.selector ?? "") in controls;
}

export async function exerciseBottomTabControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const selector = assignment.surface.selector ?? "";
  const target = controls[selector as keyof typeof controls];
  const baseline: BottomTab = target === "Chat" ? "Logs" : "Chat";
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native bottom-tab effect was observed.",
  };
  try {
    if (!target || assignment.fixtureId !== BOTTOM_TAB_FIXTURES[0]) {
      throw new Error(`bottom-tab fixture does not match ${assignment.surface.name}`);
    }
    await setBottomTab(connection, baseline, "bottom-tab setup");
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, webdriverSelector(selector));
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await waitForBottomTab(connection, target, "bottom-tab native effect");
    await waitForReleaseSurfaceInstalledInputElement(
      installedInput,
      `${webdriverSelector(selector)}.active`,
    );
    outcome.effect = "pass";
    outcome.observedEffect = `A bounded native click changed both renderer state and the active bottom-tab owner from ${baseline} to ${target}.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (target) {
        await setBottomTab(connection, baseline, "bottom-tab cleanup");
        await waitForReleaseSurfaceInstalledInputElement(
          installedInput,
          `${webdriverSelector(selectorForBottomTab(baseline))}.active`,
        );
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "bottom tab did not satisfy every required verdict";
  }
  return outcome;
}

function selectorForBottomTab(tab: BottomTab): string {
  const entry = Object.entries(controls).find(([, value]) => value === tab);
  if (!entry) throw new Error(`no bottom-tab selector exists for ${tab}`);
  return entry[0];
}

async function setBottomTab(connection: Connection, tab: BottomTab, label: string): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-bottom-tab-driver",
    openModal: "close",
    debugHighlights: [],
    bottomTab: tab,
  });
  await waitForBottomTab(connection, tab, label);
}

async function waitForBottomTab(connection: Connection, tab: BottomTab, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    if (state.bottomTab === tab) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} did not reach ${tab} before timeout`);
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
