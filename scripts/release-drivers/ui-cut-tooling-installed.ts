import {
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import type { ReleaseSurfaceDriverOutcome, ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";
import {
  CUT_TOOLING_CLEANUP,
  CUT_TOOLING_CONTROL_SURFACE_IDS,
  CUT_TOOLING_FIXTURE,
  CUT_TOOLING_ORACLE,
} from "./ui-cut-tooling-installed-assignments";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type RightRailTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";

const CHECK_SURFACE = 'ui-control:src/components/CutToolingRow.tsx:[aria-label="Check ShellX Cut status"]@src/components/CutToolingRow.tsx#1';
const OPEN_SURFACE = 'ui-control:src/components/CutToolingRow.tsx::is([aria-label="Open ShellX Cut"],[aria-label="ShellX Cut Open unavailable"])@src/components/CutToolingRow.tsx#2';
const CHECK = "[aria-label='Check ShellX Cut status']";
const OPEN_UNAVAILABLE = "[aria-label='ShellX Cut Open unavailable']";
const ROW_UNSUPPORTED = "[data-shellx-cut-tooling-row='selected-session'][data-shellx-cut-state='unsupportedTarget']";
const CHECKED_UNSUPPORTED = `${ROW_UNSUPPORTED}[data-shellx-cut-check-sequence='1']`;
const ISSUE = "[data-shellx-cut-tooling-row='selected-session'] .tooling-issue";
const TIMEOUT_MS = 8_000;
const RIGHT_TABS: RightRailTab[] = ["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"];

export async function exerciseCutToolingControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = outcomeMap(assignments);
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  let originalRightTab: RightRailTab | null = null;
  let error: string | null = null;
  let cleanupError: string | null = null;
  try {
    const ui = await apiJson(connection, "GET", "/state/ui");
    const activeTabId = requireString(ui.activeTabId, "active Task/Cut tab");
    originalRightTab = requireRightRailTab(ui.rightTab);
    const preflight = requireRecord(await relay.invoke("session_tooling_snapshot", { tabId: activeTabId }), "Cut tooling preflight");
    requireUnsupportedCutStatus(preflight.cut);

    await selectRightTab(connection, input, "Tooling");
    await waitForReleaseSurfaceInstalledInputElement(input, `${ROW_UNSUPPORTED}[data-shellx-cut-check-sequence='0']`, {
      timeoutMs: TIMEOUT_MS,
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, ISSUE, { timeoutMs: 500, pollMs: 50 });

    const check = await waitForReleaseSurfaceInstalledInputElement(input, CHECK, { timeoutMs: TIMEOUT_MS });
    await clickReleaseSurfaceInstalledInputElement(input, check);
    await waitForReleaseSurfaceInstalledInputElement(input, CHECKED_UNSUPPORTED, { timeoutMs: TIMEOUT_MS });
    pass(outcomes, CHECK_SURFACE,
      "Native installed input refreshed the selected session's Cut status, recorded one visible completion marker, and remained unsupported before any Cut binary probe or editor launch.");

    const open = await waitForReleaseSurfaceInstalledInputElement(input, OPEN_UNAVAILABLE, { timeoutMs: TIMEOUT_MS });
    const disabled = await observeReleaseSurfaceInstalledInputElement(input, OPEN_UNAVAILABLE, ["disabled", "title"]);
    if (!disabled.present || !disabled.visible || disabled.disabled !== true
      || typeof disabled.title !== "string" || !disabled.title.includes("active ShellX session")) {
      throw new Error("Cut Open unavailable did not expose its exact disabled host-context explanation");
    }
    try {
      await clickReleaseSurfaceInstalledInputElement(input, open);
    } catch {
      // W3C WebDriver is allowed to reject a click on a disabled native control.
    }
    await waitForReleaseSurfaceInstalledInputElement(input, CHECKED_UNSUPPORTED, { timeoutMs: TIMEOUT_MS });
    const stillDisabled = await observeReleaseSurfaceInstalledInputElement(input, OPEN_UNAVAILABLE, ["disabled"]);
    if (!stillDisabled.present || !stillDisabled.visible || stillDisabled.disabled !== true) {
      throw new Error("Cut Open unavailable changed after its bounded native activation attempt");
    }
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, ISSUE, { timeoutMs: 500, pollMs: 50 });
    pass(outcomes, OPEN_SURFACE,
      "The exact dynamic Cut Open control rendered as disabled for a session without desktop-host context; a bounded native activation attempt produced no launch, error, or state change.");
  } catch (caught) {
    error = errorText(caught);
  } finally {
    const errors: string[] = [];
    if (originalRightTab) {
      try {
        await selectRightTab(connection, input, originalRightTab);
      } catch (caught) {
        errors.push(errorText(caught));
      }
    }
    try {
      await relay.cleanup();
    } catch (caught) {
      errors.push(errorText(caught));
    }
    cleanupError = errors.length > 0 ? errors.join("; ") : null;
  }
  return finalize(assignments, outcomes, error, cleanupError);
}

function validateAssignments(assignments: Assignment[]): void {
  const ids = new Set(assignments.map((assignment) => assignment.surface.id));
  if (assignments.length !== CUT_TOOLING_CONTROL_SURFACE_IDS.size || ids.size !== CUT_TOOLING_CONTROL_SURFACE_IDS.size
    || [...CUT_TOOLING_CONTROL_SURFACE_IDS].some((id) => !ids.has(id))) {
    throw new Error(`Cut Tooling driver requires exactly ${CUT_TOOLING_CONTROL_SURFACE_IDS.size} controls`);
  }
  for (const assignment of assignments) {
    if (assignment.fixtureId !== CUT_TOOLING_FIXTURE || assignment.cleanupId !== CUT_TOOLING_CLEANUP
      || assignment.oracleId !== CUT_TOOLING_ORACLE) {
      throw new Error(`Cut Tooling assignment omitted its exact contract: ${assignment.surface.id}`);
    }
  }
}

function requireUnsupportedCutStatus(value: unknown): void {
  const status = requireRecord(value, "Cut tooling status");
  if (status.schemaVersion !== "shellx.cut.tooling-status.v1"
    || status.status !== "unsupportedTarget"
    || status.target !== "no active ShellX host context"
    || status.canOpen !== false
    || typeof status.detail !== "string"
    || !status.detail.includes("active ShellX desktop-host context")) {
    throw new Error("Cut tooling preflight did not prove the exact no-host-context boundary");
  }
}

async function selectRightTab(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  tab: RightRailTab,
): Promise<void> {
  const selector = `[data-debug-id='right-tab-${tab.toLowerCase()}']`;
  const current = await apiJson(connection, "GET", "/state/ui");
  if (current.rightTab !== tab) {
    const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
    await clickReleaseSurfaceInstalledInputElement(input, element);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const observed = await observeReleaseSurfaceInstalledInputElement(input, `${selector}.active[aria-selected='true']`, []);
    if (state.rightTab === tab && observed.present && observed.visible) return;
    await delay(50);
  }
  throw new Error(`Cut Tooling fixture did not select the ${tab} right rail`);
}

function outcomeMap(assignments: Assignment[]): Map<string, ReleaseSurfaceDriverOutcome> {
  return new Map(assignments.map((assignment) => [assignment.surface.id, {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail" as const,
    invoke: "fail" as const,
    effect: "fail" as const,
    cleanup: "fail" as const,
    observedEffect: "No installed Cut Tooling control effect was observed.",
  }]));
}

function pass(outcomes: Map<string, ReleaseSurfaceDriverOutcome>, id: string, detail: string): void {
  const outcome = outcomes.get(id);
  if (!outcome) throw new Error(`Cut Tooling outcome is missing ${id}`);
  outcome.present = "pass";
  outcome.invoke = "pass";
  outcome.effect = "pass";
  outcome.observedEffect = detail;
}

function finalize(
  assignments: Assignment[],
  outcomes: Map<string, ReleaseSurfaceDriverOutcome>,
  error: string | null,
  cleanupError: string | null,
): ReleaseSurfaceDriverOutcome[] {
  for (const outcome of outcomes.values()) {
    if (!cleanupError) outcome.cleanup = "pass";
    if (error) outcome.error = error;
    if (cleanupError) outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupError}`;
    if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
      outcome.error = "Cut Tooling lifecycle did not satisfy every required verdict";
    }
  }
  return assignments.map((assignment) => outcomes.get(assignment.surface.id)!);
}

function requireRightRailTab(value: unknown): RightRailTab {
  if (typeof value === "string" && RIGHT_TABS.includes(value as RightRailTab)) return value as RightRailTab;
  throw new Error("Cut Tooling fixture requires a restorable right rail");
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} is unavailable`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${label} must be an object`);
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}`);
  return requireRecord(await response.json(), `${method} ${path}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
