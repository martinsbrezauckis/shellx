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
type RightRailTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";
type UiState = { activeTabId: string | null; rightTab: RightRailTab | null };

const GIT_REFRESH_SURFACE = 'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-1"]';
const GIT_DIFF_TABS_SURFACE = 'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-5"]';
const GIT_REVIEW_SURFACE = 'src/components/GitPane.tsx:role=button;name="Review diff"';
const MODEL_REFRESH_SURFACE = 'src/components/RightRail.tsx:[title^="Refresh model instruction cards — "][title$=" completed in this view"]';
const ENVIRONMENT_REFRESH_SURFACE = 'src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-9"]';
const ENVIRONMENT_TRACE_SURFACE = 'src/components/RightRail.tsx:role=button;name="Trace"';
const GIT_REFRESH = "[data-debug-id='surface-components-gitpane-1']";
const GIT_REVIEW = "[data-shellx-release-control='git-review-diff']";
const MODEL_REFRESH = "[data-shellx-release-control='model-cards-refresh']";
const ENVIRONMENT_REFRESH = "[data-debug-id='surface-components-rightrail-9']";
const ENVIRONMENT_TRACE = "[data-release-environment-control='trace']";
const DIFF_BOX = ".git-diff-box";
const surfaces = new Set([
  GIT_REFRESH_SURFACE,
  GIT_DIFF_TABS_SURFACE,
  GIT_REVIEW_SURFACE,
  MODEL_REFRESH_SURFACE,
  ENVIRONMENT_REFRESH_SURFACE,
  ENVIRONMENT_TRACE_SURFACE,
]);
const RIGHT_RAIL_TABS = new Set<RightRailTab>(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"]);

export const RIGHT_RAIL_GIT_READ_FIXTURES = ["ui:right-rail-git-owned-read-lifecycle"] as const;
export const RIGHT_RAIL_GIT_READ_CLEANUPS = ["ui:clear-owned-right-rail-git-fixture-and-restore-right-rail"] as const;
export const RIGHT_RAIL_GIT_READ_ORACLES = [
  "ui:activation:git-pane-manual-refresh-receipt",
  "ui:activation:git-pane-owned-diff-rendered",
  "ui:selection-state-transition",
  "ui:activation:model-cards-manual-refresh-receipt",
  "ui:activation:environment-manual-refresh-receipt",
  "ui:activation:environment-trace-export-boundary",
] as const;

export function supportsRightRailGitReadControl(assignment: Assignment): boolean {
  return surfaces.has(assignment.surface.name);
}

export async function exerciseRightRailGitReadLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [assignment.surface.name, emptyOutcome(assignment)]));
  const outcome = (surface: string): ReleaseSurfaceDriverOutcome => {
    const value = outcomes.get(surface);
    if (!value) throw new Error(`RightRail/GitPane outcome is missing ${surface}`);
    return value;
  };
  const present = (surface: string): void => { outcome(surface).present = "pass"; };
  const invoked = (surface: string): void => { outcome(surface).invoke = "pass"; };
  const effected = (surface: string, detail: string): void => {
    outcome(surface).effect = "pass";
    outcome(surface).observedEffect = detail;
  };

  let baseline: UiState | null = null;
  let fixtureApplied = false;
  let primaryError: string | null = null;
  try {
    baseline = await readUiState(connection);
    if (!baseline.activeTabId || !baseline.rightTab) {
      throw new Error("RightRail/GitPane fixture requires exact active-tab and right-rail baselines");
    }
    if (baseline.rightTab === "Git" || baseline.rightTab === "Tooling") {
      throw new Error("RightRail/GitPane fixture requires a non-Git, non-Tooling baseline to prevent live mount effects during cleanup");
    }
    for (const selector of [GIT_REFRESH, GIT_REVIEW, MODEL_REFRESH]) {
      if (await findReleaseSurfaceInstalledInputElement(installedInput, selector)) {
        throw new Error(`RightRail/GitPane owned fixture requires absent baseline control ${selector}`);
      }
    }

    fixtureApplied = true;
    await postUi(connection, {
      rightTab: "Git",
      debugRendererFixture: { id: "right-rail-git-lifecycle" },
    });
    await waitForRightTab(connection, "Git");

    const gitRefresh = await waitForReleaseSurfaceInstalledInputElement(installedInput, GIT_REFRESH);
    present(GIT_REFRESH_SURFACE);
    await requireManualRefreshSequence(installedInput, GIT_REFRESH, 0, "repository status");
    await clickReleaseSurfaceInstalledInputElement(installedInput, gitRefresh);
    invoked(GIT_REFRESH_SURFACE);
    await waitForManualRefreshSequence(installedInput, GIT_REFRESH, 1, "repository status");
    effected(GIT_REFRESH_SURFACE, "The native refresh re-read only the owned renderer snapshot and advanced its exact bounded manual-refresh receipt from 0 to 1.");

    const review = await waitForReleaseSurfaceInstalledInputElement(installedInput, GIT_REVIEW);
    present(GIT_REVIEW_SURFACE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIFF_BOX);
    await clickReleaseSurfaceInstalledInputElement(installedInput, review);
    invoked(GIT_REVIEW_SURFACE);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, DIFF_BOX);
    effected(GIT_REVIEW_SURFACE, "The native Review diff click rendered the fixed owned HEAD diff without reading a repository or filesystem.");

    for (const scope of ["working", "staged", "lastCommit", "head"] as const) {
      const selector = diffScopeSelector(scope);
      const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
      present(GIT_DIFF_TABS_SURFACE);
      await clickReleaseSurfaceInstalledInputElement(installedInput, control);
      await waitForSelected(installedInput, selector, true);
    }
    invoked(GIT_DIFF_TABS_SURFACE);
    effected(GIT_DIFF_TABS_SURFACE, "Native tab clicks selected working, staged, last-commit, and HEAD owned diffs in order, then restored the exact HEAD scope baseline.");

    await postUi(connection, { rightTab: "Tooling" });
    await waitForRightTab(connection, "Tooling");
    const modelRefresh = await waitForReleaseSurfaceInstalledInputElement(installedInput, MODEL_REFRESH);
    present(MODEL_REFRESH_SURFACE);
    await requireManualRefreshSequence(installedInput, MODEL_REFRESH, 0, "model instruction cards");
    await clickReleaseSurfaceInstalledInputElement(installedInput, modelRefresh);
    invoked(MODEL_REFRESH_SURFACE);
    await waitForManualRefreshSequence(installedInput, MODEL_REFRESH, 1, "model instruction cards");
    effected(MODEL_REFRESH_SURFACE, "The native refresh re-read only the owned renderer card policy and advanced its exact bounded manual-refresh receipt from 0 to 1.");

    const environmentRefresh = await waitForReleaseSurfaceInstalledInputElement(installedInput, ENVIRONMENT_REFRESH);
    present(ENVIRONMENT_REFRESH_SURFACE);
    await requireManualRefreshSequence(installedInput, ENVIRONMENT_REFRESH, 0, "environment snapshot");
    await clickReleaseSurfaceInstalledInputElement(installedInput, environmentRefresh);
    invoked(ENVIRONMENT_REFRESH_SURFACE);
    await waitForManualRefreshSequence(installedInput, ENVIRONMENT_REFRESH, 1, "environment snapshot");
    effected(ENVIRONMENT_REFRESH_SURFACE, "The native refresh re-read only the fixed renderer-owned environment snapshot and advanced its exact bounded manual-refresh receipt from 0 to 1 without invoking Grok CLI diagnostics.");

    const trace = await waitForReleaseSurfaceInstalledInputElement(installedInput, ENVIRONMENT_TRACE);
    present(ENVIRONMENT_TRACE_SURFACE);
    await clickReleaseSurfaceInstalledInputElement(installedInput, trace);
    invoked(ENVIRONMENT_TRACE_SURFACE);
    await waitForExactTitle(installedInput, ENVIRONMENT_TRACE, "release fixture trace export boundary completed");
    effected(ENVIRONMENT_TRACE_SURFACE, "The native Trace click invoked the production export handler and reached the fixed renderer-owned pre-filesystem receipt without creating an artifact.");
  } catch (error) {
    primaryError = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (fixtureApplied && baseline?.rightTab) {
      try {
        await postUi(connection, { rightTab: baseline.rightTab });
        await waitForRightTab(connection, baseline.rightTab);
        for (const selector of [GIT_REFRESH, GIT_REVIEW, MODEL_REFRESH, ENVIRONMENT_REFRESH, ENVIRONMENT_TRACE, DIFF_BOX]) {
          await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, selector);
        }
        await postUi(connection, {
          debugRendererFixture: { id: "right-rail-git-lifecycle", action: "clear" },
        });
      } catch (error) {
        cleanupErrors.push(`owned read fixture: ${errorMessage(error)}`);
      }
    }
    if (baseline) {
      try {
        const restored = await readUiState(connection);
        if (restored.activeTabId !== baseline.activeTabId || restored.rightTab !== baseline.rightTab) {
          throw new Error("RightRail/GitPane cleanup did not restore exact active-tab and right-rail baselines");
        }
      } catch (error) {
        cleanupErrors.push(`view baseline: ${errorMessage(error)}`);
      }
    }
    const cleanupError = cleanupErrors.join("; ");
    for (const value of outcomes.values()) {
      if (!cleanupError) value.cleanup = "pass";
      if (primaryError && !value.error) value.error = primaryError;
      if (cleanupError) value.error = appendError(value.error, `cleanup: ${cleanupError}`);
      if ([value.present, value.invoke, value.effect, value.cleanup].includes("fail") && !value.error) {
        value.error = "RightRail/GitPane read lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => outcome(assignment.surface.name));
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== surfaces.size) {
    throw new Error(`RightRail/GitPane read lifecycle requires exactly ${surfaces.size} assignments`);
  }
  const names = new Set(assignments.map((assignment) => assignment.surface.name));
  for (const assignment of assignments) {
    if (!supportsRightRailGitReadControl(assignment)
      || assignment.fixtureId !== RIGHT_RAIL_GIT_READ_FIXTURES[0]
      || assignment.cleanupId !== RIGHT_RAIL_GIT_READ_CLEANUPS[0]) {
      throw new Error(`RightRail/GitPane assignment does not match ${assignment.surface.name}`);
    }
  }
  for (const surface of surfaces) if (!names.has(surface)) throw new Error(`RightRail/GitPane assignment is missing ${surface}`);
}

function diffScopeSelector(scope: "head" | "working" | "staged" | "lastCommit"): string {
  return `[data-debug-id='surface-components-gitpane-5'][data-git-diff-scope='${scope}']`;
}

async function requireManualRefreshSequence(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: number,
  label: string,
): Promise<void> {
  const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["title"]);
  const match = value.title?.match(/— (\d+) manual refresh(?:es)? completed in this view$/);
  if (!match || Number(match[1]) !== expected) throw new Error(`${label} omitted exact manual refresh sequence ${expected}`);
}

async function waitForManualRefreshSequence(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await requireManualRefreshSequence(installedInput, selector, expected, label);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`${label} did not reach exact manual refresh sequence ${expected}`);
}

async function waitForExactTitle(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["title"]);
    if (value.present && value.visible && value.title === expected) return;
    await delay(50);
  }
  throw new Error(selector + " did not reach exact title " + expected);
}

async function waitForSelected(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["selected"]);
    if (value.selected === expected) return;
    await delay(50);
  }
  throw new Error(`Git diff scope ${selector} did not reach selected=${expected}`);
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
    observedEffect: "No native owned RightRail/GitPane read lifecycle effect was observed.",
  };
}

async function readUiState(connection: Connection): Promise<UiState> {
  const value = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    rightTab: typeof value.rightTab === "string" && RIGHT_RAIL_TABS.has(value.rightTab as RightRailTab)
      ? value.rightTab as RightRailTab
      : null,
  };
}

async function waitForRightTab(connection: Connection, expected: RightRailTab): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readUiState(connection)).rightTab === expected) return;
    await delay(50);
  }
  throw new Error(`right rail did not reach ${expected}`);
}

async function postUi(connection: Connection, patch: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-right-rail-git-read-lifecycle",
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
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
