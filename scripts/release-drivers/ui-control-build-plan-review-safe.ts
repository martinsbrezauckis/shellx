import {
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type RightRailTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";

const CLOSE_SURFACE = "src/components/BuildPlanReviewModal.tsx:[aria-label=\"Review later\"]";
const LATER_SURFACE = "src/components/BuildPlanReviewModal.tsx:role=button;name=\"Review later\"";
const DIALOG = "[role='dialog'][aria-label^='Review build plan:']";
const CLOSE_CONTROL = `${DIALOG} [aria-label='Review later']`;
const LATER_CONTROL = `${DIALOG} .plan-review-actions > button:first-child`;
const REJECT_CONTROL = "[data-debug-id='surface-components-buildplanreviewmodal-4']";
const ACCEPT_CONTROL = "[data-debug-id='surface-components-buildplanreviewmodal-5']";
const RIGHT_RAIL_TABS = new Set<RightRailTab>(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"]);

export const BUILD_PLAN_REVIEW_SAFE_FIXTURES = ["ui:build-plan-review-owned-inert"] as const;
export const BUILD_PLAN_REVIEW_SAFE_CLEANUPS = [
  "ui:clear-owned-build-plan-review-and-restore-right-rail",
] as const;
export const BUILD_PLAN_REVIEW_SAFE_ORACLES = [
  "ui:activation:build-plan-review-dismissed",
] as const;

export function supportsBuildPlanReviewSafeControl(assignment: Assignment): boolean {
  return assignment.surface.name === CLOSE_SURFACE || assignment.surface.name === LATER_SURFACE;
}

export async function exerciseBuildPlanReviewSafeControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let originalRightTab: RightRailTab | null = null;
  try {
    originalRightTab = await currentRightTab(connection);
    await prepareFixture(connection, installedInput);
    await expectUnsafeActionsDisabled(installedInput);
    const selector = assignment.surface.name === CLOSE_SURFACE ? CLOSE_CONTROL : LATER_CONTROL;
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    await waitForRightTab(connection, "Plan");
    outcome.effect = "pass";
    outcome.observedEffect = "A native installed-input click dismissed the exact renderer-only Build plan review and moved its reversible UI handoff to the Plan tab; Reject and Accept plan stayed disabled and no Build state, provider, project, clipboard, or navigation action was invoked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (originalRightTab) applyCleanup(
      outcome,
      await cleanupFixture(connection, installedInput, originalRightTab),
    );
  }
  return finalize(outcome);
}

async function prepareFixture(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  const ui = await apiJson(connection, "GET", "/state/ui");
  const tabId = typeof ui.activeTabId === "string" ? ui.activeTabId : "";
  if (!tabId) throw new Error("Build plan fixture requires one exact active renderer tab");
  const build = await apiJson(connection, "GET", `/build/state?tabId=${encodeURIComponent(tabId)}`);
  if (build.state !== null) throw new Error("Build plan fixture refuses to overlay an operator Build run");

  await postUi(connection, {
    openModal: "close",
    debugBuildPlanFixture: "clear",
    rightTab: "Tasks",
    source: "final-surface-owned-build-plan-baseline",
  });
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
  await waitForRightTab(connection, "Tasks");
  await postUi(connection, {
    debugBuildPlanFixture: "owned-ready",
    openModal: "buildPlanReview",
    source: "final-surface-owned-build-plan-open",
  });
  await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG, {
    timeoutMs: 8_000,
    pollMs: 75,
  });
}

async function currentRightTab(connection: Connection): Promise<RightRailTab> {
  return requireRightRailTab((await apiJson(connection, "GET", "/state/ui")).rightTab);
}

async function expectUnsafeActionsDisabled(
  installedInput: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  for (const selector of [REJECT_CONTROL, ACCEPT_CONTROL]) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["disabled"]);
    if (!state.present || !state.visible || state.disabled !== true) {
      throw new Error(`renderer-only Build plan fixture did not disable ${selector}`);
    }
  }
}

async function cleanupFixture(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  originalRightTab: RightRailTab,
): Promise<string | null> {
  try {
    await postUi(connection, {
      openModal: "close",
      debugBuildPlanFixture: "clear",
      rightTab: originalRightTab,
      source: "final-surface-owned-build-plan-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    await waitForRightTab(connection, originalRightTab);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

async function waitForRightTab(connection: Connection, expected: RightRailTab): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ui = await apiJson(connection, "GET", "/state/ui");
    if (ui.rightTab === expected) return;
    await delay(50);
  }
  throw new Error(`right rail did not reach ${expected}`);
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
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

function requireRightRailTab(value: unknown): RightRailTab {
  if (typeof value === "string" && RIGHT_RAIL_TABS.has(value as RightRailTab)) return value as RightRailTab;
  throw new Error(`unsupported original right rail tab ${String(value)}`);
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
    observedEffect: "No inert Build plan review dismissal was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, cleanupError: string | null): void {
  if (!cleanupError) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Build plan review control did not satisfy every inert lifecycle verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
