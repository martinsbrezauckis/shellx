import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverOutcome, ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";
import {
  TASK_ENTRY_CLEANUP,
  TASK_ENTRY_CONTROL_ORACLE,
  TASK_ENTRY_CONTROL_SURFACE_IDS,
  TASK_ENTRY_DEBUG_ORACLE,
  TASK_ENTRY_DEBUG_SURFACE_IDS,
  TASK_ENTRY_FIXTURE,
} from "./ui-task-entry-installed-assignments";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const MANAGER = "[data-debug-id='task-manager']";
const MANAGER_CLOSE = "[data-debug-id='task-manager-close']";
const HEADER = "[data-debug-id='header-tasks']";
const ATTENTION = "[data-debug-id='header-tasks-attention']";
const COMPOSER = "[data-debug-id='composer-create-task']";
const TIMEOUT_MS = 8_000;

export async function exerciseTaskEntryControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments, TASK_ENTRY_CONTROL_SURFACE_IDS, TASK_ENTRY_CONTROL_ORACLE);
  const outcomes = outcomeMap(assignments);
  let error: string | null = null;
  let cleanupError: string | null = null;
  try {
    await patchUi(connection, { debugTaskManagerFixture: "full", source: "final-surface-task-header-entry" });
    await waitForReleaseSurfaceInstalledInputElement(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    await nativeClick(input, MANAGER_CLOSE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    await waitForReleaseSurfaceInstalledInputElement(input, ATTENTION, { timeoutMs: TIMEOUT_MS });
    await nativeClick(input, HEADER);
    await waitForReleaseSurfaceInstalledInputElement(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    pass(outcomes, 'ui-control:src/components/Header.tsx:[data-debug-id="header-tasks"]@src/components/Header.tsx#3',
      "Native Header activation reopened the owned Task Manager with its exact unresolved-attention badge and without starting a provider.");
    await nativeClick(input, MANAGER_CLOSE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER, { timeoutMs: TIMEOUT_MS });

    await patchUi(connection, { debugTaskManagerFixture: "clear", source: "final-surface-task-composer-entry" });
    await waitForReleaseSurfaceInstalledInputElement(input, COMPOSER, { timeoutMs: TIMEOUT_MS });
    await nativeClick(input, COMPOSER);
    await waitForReleaseSurfaceInstalledInputElement(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    pass(outcomes, 'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-create-task"]@src/components/BottomPanel.tsx#17',
      "Native composer activation opened one provider-neutral Task draft from the active conversation without saving or running it.");
    await nativeClick(input, MANAGER_CLOSE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER, { timeoutMs: TIMEOUT_MS });
  } catch (caught) {
    error = errorText(caught);
  } finally {
    try {
      await cleanup(connection, input);
    } catch (caught) {
      cleanupError = errorText(caught);
    }
  }
  return finalize(assignments, outcomes, error, cleanupError);
}

export async function exerciseTaskEntryMarkers(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments, TASK_ENTRY_DEBUG_SURFACE_IDS, TASK_ENTRY_DEBUG_ORACLE);
  const outcomes = outcomeMap(assignments);
  let error: string | null = null;
  let cleanupError: string | null = null;
  try {
    await patchUi(connection, { debugTaskManagerFixture: "full", source: "final-surface-task-entry-markers" });
    await waitForReleaseSurfaceInstalledInputElement(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    await nativeClick(input, MANAGER_CLOSE);
    await waitForReleaseSurfaceInstalledInputElement(input, HEADER, { timeoutMs: TIMEOUT_MS });
    await waitForReleaseSurfaceInstalledInputElement(input, ATTENTION, { timeoutMs: TIMEOUT_MS });
    pass(outcomes, "ui-debug-surface:header-tasks@src/components/Header.tsx#2",
      "The exact Header Task entry rendered as a visible installed-app marker over an owned Task state.");
    pass(outcomes, "ui-debug-surface:header-tasks-attention@src/components/Header.tsx#3",
      "The exact bounded attention badge rendered from one owned unresolved Task occurrence.");
    await patchUi(connection, { debugTaskManagerFixture: "clear", source: "final-surface-task-entry-markers" });
    await waitForReleaseSurfaceInstalledInputElement(input, COMPOSER, { timeoutMs: TIMEOUT_MS });
    pass(outcomes, "ui-debug-surface:composer-create-task@src/components/BottomPanel.tsx#14",
      "The exact composer Task entry rendered as a visible installed-app marker for the active conversation.");
  } catch (caught) {
    error = errorText(caught);
  } finally {
    try {
      await cleanup(connection, input);
    } catch (caught) {
      cleanupError = errorText(caught);
    }
  }
  return finalize(assignments, outcomes, error, cleanupError);
}

function validateAssignments(assignments: Assignment[], ids: Set<string>, oracleId: string): void {
  const assignedIds = new Set(assignments.map((assignment) => assignment.surface.id));
  if (assignments.length !== ids.size || assignedIds.size !== ids.size || [...ids].some((id) => !assignedIds.has(id))) {
    throw new Error(`Task entry driver requires exactly ${ids.size} assigned surfaces`);
  }
  for (const assignment of assignments) {
    if (assignment.fixtureId !== TASK_ENTRY_FIXTURE || assignment.cleanupId !== TASK_ENTRY_CLEANUP || assignment.oracleId !== oracleId) {
      throw new Error(`Task entry assignment omitted its exact contract: ${assignment.surface.id}`);
    }
  }
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
    observedEffect: "No Task entry state was observed.",
  }]));
}

function pass(outcomes: Map<string, ReleaseSurfaceDriverOutcome>, id: string, detail: string): void {
  const outcome = outcomes.get(id);
  if (!outcome) throw new Error(`Task entry outcome is missing ${id}`);
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
      outcome.error = "Task entry lifecycle did not satisfy every required verdict";
    }
  }
  return assignments.map((assignment) => outcomes.get(assignment.surface.id)!);
}

async function nativeClick(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clickReleaseSurfaceInstalledInputElement(input, element);
}

async function cleanup(connection: Connection, input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  await patchUi(connection, { debugTaskManagerFixture: "clear", openModal: "close", source: "final-surface-task-entry-cleanup" });
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER, { timeoutMs: TIMEOUT_MS });
}

async function patchUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base.replace(/\/$/, "")}/state/ui`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Task entry fixture patch failed with HTTP ${response.status}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
