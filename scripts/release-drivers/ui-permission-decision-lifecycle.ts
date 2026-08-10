import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
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
type UiBaseline = { activeTabId: string; bottomTab: string };
type Decision = "allow" | "allow_always" | "deny";
type Action = {
  surface: string;
  command: string;
  fixtureId: string;
  selector: string;
  decision: Decision;
};

const FIXTURE_ID = "permission-decision-lifecycle";
const CLEANUP_ID = "ui:clear-owned-permission-decision-and-restore-view";
const RECEIPT = "[data-shellx-release-control='permission-decision-receipt']";
const PILL_ALLOW = "[data-debug-id='surface-components-permissionpill-1']";
const PILL_ALWAYS = "[data-shellx-release-control='permission-pill-always']";
const PILL_DENY = "[data-debug-id='surface-components-permissionpill-3']";
const PENDING_SELECTORS = [
  PILL_ALLOW,
  PILL_ALWAYS,
  PILL_DENY,
];

const ACTIONS: readonly Action[] = [
  {
    surface: 'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-1"]',
    command: "pill-allow",
    fixtureId: "ui:permission-owned-pill-allow",
    selector: PILL_ALLOW,
    decision: "allow",
  },
  {
    surface: 'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-3"]',
    command: "pill-deny",
    fixtureId: "ui:permission-owned-pill-deny",
    selector: PILL_DENY,
    decision: "deny",
  },
  {
    surface: 'src/components/PermissionPill.tsx:[title="Allow this tool every time without asking"]',
    command: "pill-always",
    fixtureId: "ui:permission-owned-pill-always",
    selector: PILL_ALWAYS,
    decision: "allow_always",
  },
];

export const PERMISSION_CONTROL_FIXTURES = ACTIONS.map((action) => action.fixtureId);
export const PERMISSION_CONTROL_CLEANUPS = [CLEANUP_ID] as const;
export const PERMISSION_CONTROL_ORACLES = ACTIONS.map(permissionOracle);

export function supportsPermissionDecisionControl(assignment: Assignment): boolean {
  const action = ACTIONS.find((candidate) => candidate.surface === assignment.surface.name);
  return Boolean(
    action
    && assignment.fixtureId === action.fixtureId
    && assignment.cleanupId === CLEANUP_ID
    && assignment.oracleId === permissionOracle(action),
  );
}

export async function exercisePermissionDecisionControls(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  if (assignments.length !== ACTIONS.length || !assignments.every(supportsPermissionDecisionControl)) {
    throw new Error("permission decision control driver requires all three exact pill assignments");
  }
  const baseline = await readBaseline(connection);
  await requireFixtureAbsent(installedInput);
  const byName = new Map(assignments.map((assignment) => [assignment.surface.name, assignment]));
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const action of ACTIONS) {
    const assignment = byName.get(action.surface);
    if (!assignment) throw new Error("missing permission action assignment " + action.surface);
    outcomes.push(await exerciseAction(connection, installedInput, assignment, action, baseline));
  }
  return outcomes;
}

async function exerciseAction(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  action: Action,
  baseline: UiBaseline,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let fixtureApplied = false;
  try {
    await requireFixtureAbsent(installedInput);
    fixtureApplied = true;
    await postUi(connection, {
      bottomTab: "Chat",
      debugRendererFixture: { id: FIXTURE_ID, action: action.command },
    });
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, action.selector);
    outcome.present = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, RECEIPT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, action.selector);
    const expectedTitle = "Permission decision receipt — " + action.command + " — " + action.decision;
    await waitForReceipt(installedInput, expectedTitle);
    outcome.effect = "pass";
    outcome.observedEffect = "Native installed input drove the real component callback from pending to "
      + action.decision
      + " and produced the exact renderer-only receipt without resolving a provider request or changing persistent permission policy.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupError = fixtureApplied
      ? await cleanupFixture(connection, installedInput, baseline)
      : null;
    if (!cleanupError) outcome.cleanup = "pass";
    if (cleanupError) outcome.error = appendError(outcome.error, "cleanup: " + cleanupError);
  }
  return outcome;
}

async function waitForReceipt(
  installedInput: ReleaseSurfaceInstalledInputSession,
  expectedTitle: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await waitForReleaseSurfaceInstalledInputElement(installedInput, RECEIPT);
      const observed = await observeReleaseSurfaceInstalledInputElement(
        installedInput,
        RECEIPT,
        ["title"],
      );
      if (observed.title === expectedTitle) return;
    } catch {
      // The component transition is still in flight.
    }
    await delay(50);
  }
  throw new Error("permission decision receipt did not reach " + expectedTitle);
}

async function cleanupFixture(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  baseline: UiBaseline,
): Promise<string | null> {
  try {
    await postUi(connection, {
      bottomTab: baseline.bottomTab,
      debugRendererFixture: { id: FIXTURE_ID, action: "clear" },
    });
    await requireFixtureAbsent(installedInput);
    const restored = await readBaseline(connection);
    if (restored.activeTabId !== baseline.activeTabId || restored.bottomTab !== baseline.bottomTab) {
      throw new Error("permission cleanup did not restore exact active-tab and bottom-tab memory");
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

async function requireFixtureAbsent(
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  for (const selector of [...PENDING_SELECTORS, RECEIPT]) {
    if (await findReleaseSurfaceInstalledInputElement(installedInput, selector)) {
      throw new Error("permission fixture requires absent baseline " + selector);
    }
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
    observedEffect: "No owned permission decision transition was observed.",
  };
}

function permissionOracle(action: Action): string {
  return "ui:activation:permission-" + action.command + "-transition";
}

async function readBaseline(connection: Connection): Promise<UiBaseline> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  if (typeof state.activeTabId !== "string" || typeof state.bottomTab !== "string") {
    throw new Error("permission fixture requires exact active-tab and bottom-tab baselines");
  }
  return { activeTabId: state.activeTabId, bottomTab: state.bottomTab };
}

async function postUi(connection: Connection, patch: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-permission-decision-lifecycle",
    ...patch,
  });
  await delay(150);
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(connection.base + path, {
    method,
    headers: {
      Authorization: "Bearer " + connection.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(method + " " + path + " failed " + response.status + ": " + text.slice(0, 800));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | undefined, detail: string): string {
  return current ? current + "; " + detail : detail;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
