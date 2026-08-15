import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverOutcome, ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";
import {
  TASK_MANAGER_CONTROL_CLEANUP,
  TASK_MANAGER_CONTROL_FIXTURE,
  TASK_MANAGER_CONTROL_ORACLES,
  TASK_MANAGER_CONTROL_SURFACE_NAMES,
  supportsTaskManagerControl,
  taskManagerControlOracle,
} from "./ui-task-manager-installed-assignments";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const MANAGER = "[data-debug-id='task-manager']";
const EMPTY = "[data-debug-id='task-manager-empty']";
const DEFINITION = "[data-debug-id='task-manager-definition-task-fixture-001']";
const FEEDBACK_ACTION = "[data-task-manager-feedback-state='action']";
const PREFIX = "src/components/TaskManager.tsx:";
const HISTORY_PREFIX = "src/components/TaskRunHistory.tsx:";
const TIMEOUT_MS = 8_000;

const NAMES = {
  actions: `${PREFIX}[data-debug-id^="task-manager-action-"]`,
  definition: `${PREFIX}[data-debug-id^="task-manager-definition-"]`,
  model: `${PREFIX}[data-debug-id^="task-manager-model-"]`,
  moveDown: `${PREFIX}[data-debug-id^="task-manager-provider-"][data-debug-id$="-move-down"]`,
  moveUp: `${PREFIX}[data-debug-id^="task-manager-provider-"][data-debug-id$="-move-up"]`,
  removeProvider: `${PREFIX}[data-debug-id^="task-manager-provider-"][data-debug-id$="-remove"]`,
  toggleProvider: `${PREFIX}[data-debug-id^="task-manager-provider-"][data-debug-id$="-toggle"]`,
  weekday: `${PREFIX}[data-debug-id^="task-manager-weekday-"]`,
  acknowledge: `${PREFIX}[data-debug-id="task-manager-acknowledge-attention"]`,
  backdrop: `${PREFIX}[data-debug-id="task-manager-backdrop"]`,
  close: `${PREFIX}[data-debug-id="task-manager-close"]`,
  enabled: `${PREFIX}[data-debug-id="task-manager-enabled"]`,
  environmentFilter: `${PREFIX}[data-debug-id="task-manager-environment-filter"]`,
  environment: `${PREFIX}[data-debug-id="task-manager-environment"]`,
  instruction: `${PREFIX}[data-debug-id="task-manager-instruction"]`,
  maxRun: `${PREFIX}[data-debug-id="task-manager-max-run-seconds"]`,
  scheduleAdvanced: `${PREFIX}[data-debug-id="task-manager-schedule-advanced"]`,
  missedRun: `${PREFIX}[data-debug-id="task-manager-missed-run-policy"]`,
  name: `${PREFIX}[data-debug-id="task-manager-name"]`,
  notifications: `${PREFIX}[data-debug-id="task-manager-notification-policy"]`,
  openVault: `${PREFIX}[data-debug-id="task-manager-open-vault"]`,
  projectFilter: `${PREFIX}[data-debug-id="task-manager-project-filter"]`,
  providerFilter: `${PREFIX}[data-debug-id="task-manager-provider-filter"]`,
  recheck: `${PREFIX}[data-debug-id="task-manager-recheck"]`,
  removeAttachment: `${PREFIX}[data-debug-id="task-manager-remove-attachment"]`,
  removeVault: `${PREFIX}[data-debug-id="task-manager-remove-vault-requirement"]`,
  removeWorkflow: `${PREFIX}[data-debug-id="task-manager-remove-workflow"]`,
  search: `${PREFIX}[data-debug-id="task-manager-search"]`,
  success: `${PREFIX}[data-debug-id="task-manager-success-criteria"]`,
  timezone: `${PREFIX}[data-debug-id="task-manager-timezone"]`,
  triggerKind: `${PREFIX}[data-debug-id="task-manager-trigger-kind"]`,
  monthDay: `${PREFIX}[data-debug-id="task-manager-trigger-month-day"]`,
  triggerOnce: `${PREFIX}[data-debug-id="task-manager-trigger-once"]`,
  triggerTime: `${PREFIX}[data-debug-id="task-manager-trigger-time"]`,
  vaultGrant: `${PREFIX}[data-debug-id="task-manager-vault-grant"]`,
  cancelRun: `${HISTORY_PREFIX}[data-debug-id^="task-manager-cancel-run-"]`,
  openRun: `${HISTORY_PREFIX}[data-debug-id^="task-manager-open-run-"]`,
} as const;

export async function exerciseTaskManagerControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [assignment.surface.name, emptyOutcome(assignment)]));
  let primaryError: string | null = null;
  let cleanupError: string | null = null;
  const pass = (name: string, detail: string): void => {
    const outcome = requiredOutcome(outcomes, name);
    outcome.present = "pass";
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = detail;
  };

  try {
    await resetFixture(connection, input);
    await exerciseListControls(input, pass);
    await resetFixture(connection, input);
    await exerciseDefinitionControls(input, pass);
    await resetFixture(connection, input);
    await exerciseScheduleControls(input, assignments, pass);
    await resetFixture(connection, input);
    await exerciseProviderControls(connection, input, pass);
    await resetFixture(connection, input);
    await exerciseRunAndFooterControls(connection, input, pass);
    await resetFixture(connection, input);
    await exerciseCloseControls(connection, input, pass);
  } catch (error) {
    primaryError = errorText(error);
  } finally {
    try {
      await patchUi(connection, { debugTaskManagerFixture: "clear", openModal: "close", source: "final-surface-task-manager-cleanup" });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER, { timeoutMs: TIMEOUT_MS });
    } catch (error) {
      cleanupError = errorText(error);
    }
    for (const outcome of outcomes.values()) {
      if (!cleanupError) outcome.cleanup = "pass";
      if (primaryError) outcome.error = primaryError;
      if (cleanupError) outcome.error = `${outcome.error ? `${outcome.error}; ` : ""}cleanup: ${cleanupError}`;
      if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
        outcome.error = "Task Manager control lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => requiredOutcome(outcomes, assignment.surface.name));
}

async function exerciseListControls(
  input: ReleaseSurfaceInstalledInputSession,
  pass: (name: string, detail: string) => void,
): Promise<void> {
  await replaceValue(input, "[data-debug-id='task-manager-search']", "no-owned-match");
  await waitForReleaseSurfaceInstalledInputElement(input, EMPTY);
  await replaceValue(input, "[data-debug-id='task-manager-search']", "");
  await waitForReleaseSurfaceInstalledInputElement(input, DEFINITION);
  pass(NAMES.search, "Native text entry filtered the owned task to an empty result and clearing restored the exact definition.");

  for (const filter of ["all", "needsAttention", "paused", "recent", "running", "scheduled"] as const) {
    const selector = `[data-debug-id='task-manager-filter-${filter}']`;
    await nativeClick(input, selector);
    await waitBoolean(input, selector, "pressed", true);
    if (filter === "all" || filter === "needsAttention") await waitForReleaseSurfaceInstalledInputElement(input, DEFINITION);
    else await waitForReleaseSurfaceInstalledInputElement(input, EMPTY);
    pass(`${PREFIX}[data-debug-id="task-manager-filter-${filter}"]`, `Native selection applied the exact ${filter} Task state filter.`);
  }
  await nativeClick(input, "[data-debug-id='task-manager-filter-all']");
  for (const [name, selector, inputText, expected] of [
    [NAMES.projectFilter, "[data-debug-id='task-manager-project-filter']", "ShellX", "ShellX"],
    [NAMES.environmentFilter, "[data-debug-id='task-manager-environment-filter']", "Local linux", "local"],
    [NAMES.providerFilter, "[data-debug-id='task-manager-provider-filter']", "Grok", "grok"],
  ] as const) {
    await selectValue(input, selector, inputText, expected);
    await waitForReleaseSurfaceInstalledInputElement(input, DEFINITION);
    pass(name, `Native selection applied exact bounded Task filter value ${expected}.`);
  }
  await nativeClick(input, DEFINITION);
  await waitForReleaseSurfaceInstalledInputElement(input, `${DEFINITION}[aria-current='true']`);
  pass(NAMES.definition, "Native selection retained the exact immutable Task definition and loaded inspector.");
}

async function exerciseDefinitionControls(
  input: ReleaseSurfaceInstalledInputSession,
  pass: (name: string, detail: string) => void,
): Promise<void> {
  for (const [name, selector, value] of [
    [NAMES.name, "[data-debug-id='task-manager-name']", "Owned release task"],
    [NAMES.instruction, "[data-debug-id='task-manager-instruction']", "Inspect only the owned release fixture."],
    [NAMES.success, "[data-debug-id='task-manager-success-criteria']", "Record one bounded receipt."],
  ] as const) {
    await replaceValue(input, selector, value);
    pass(name, `Native text entry committed an exact bounded draft value for ${selector}.`);
  }
  await nativeClick(input, "[data-debug-id='task-manager-enabled']");
  await waitBoolean(input, "[data-debug-id='task-manager-enabled']", "checked", false);
  await nativeClick(input, "[data-debug-id='task-manager-enabled']");
  await waitBoolean(input, "[data-debug-id='task-manager-enabled']", "checked", true);
  pass(NAMES.enabled, "Two native clicks toggled the draft schedule off and back on.");

  await selectValue(input, "[data-debug-id='task-manager-vault-grant']", "Select active grant…", "");
  await selectValue(input, "[data-debug-id='task-manager-vault-grant']", "Browser fill · https://example.invalid · vault-grant-fixture", "vault-grant-fixture");
  pass(NAMES.vaultGrant, "Native selection cleared and restored the exact mediated Vault grant identity.");

  await nativeClick(input, "[data-debug-id='task-manager-remove-attachment']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-attachment-binding']");
  pass(NAMES.removeAttachment, "Native Remove deleted only the unsaved durable attachment reference.");
  await nativeClick(input, "[data-debug-id='task-manager-remove-workflow']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-workflow-binding']");
  pass(NAMES.removeWorkflow, "Native Remove deleted only the unsaved Browser workflow binding.");
  await nativeClick(input, "[data-debug-id='task-manager-remove-vault-requirement']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-vault-binding']");
  pass(NAMES.removeVault, "Native Remove deleted only the unsaved Vault requirement.");
}

async function exerciseScheduleControls(
  input: ReleaseSurfaceInstalledInputSession,
  assignments: Assignment[],
  pass: (name: string, detail: string) => void,
): Promise<void> {
  await selectValue(input, "[data-debug-id='task-manager-trigger-kind']", "Once", "once");
  await replaceValue(input, "[data-debug-id='task-manager-trigger-once']", "2030-01-02T03:00");
  pass(NAMES.triggerOnce, "Native date-time entry updated the exact once trigger.");
  await selectValue(input, "[data-debug-id='task-manager-trigger-kind']", "Daily", "daily");
  await replaceValue(input, "[data-debug-id='task-manager-trigger-time']", "10:30");
  pass(NAMES.triggerTime, "Native time entry updated the exact daily local time.");
  await selectValue(input, "[data-debug-id='task-manager-trigger-kind']", "Weekly", "weekly");
  await nativeClick(input, "[data-debug-id='task-manager-weekday-tuesday']");
  await waitBoolean(input, "[data-debug-id='task-manager-weekday-tuesday']", "pressed", true);
  pass(NAMES.weekday, "Native weekday selection added Tuesday to the structured weekly trigger.");
  await selectValue(input, "[data-debug-id='task-manager-trigger-kind']", "Monthly", "monthly");
  await replaceValue(input, "[data-debug-id='task-manager-trigger-month-day']", "15");
  pass(NAMES.monthDay, "Native number entry updated the exact monthly day.");
  pass(NAMES.triggerKind, "Native choice traversal rendered and edited once, daily, weekly, and monthly trigger-specific controls.");

  await nativeClick(input, "[data-debug-id='task-manager-schedule-advanced']");
  if (assignments.some((assignment) => assignment.surface.name === NAMES.scheduleAdvanced)) {
    pass(NAMES.scheduleAdvanced, "Native activation opened the bounded advanced timing and notification controls.");
  }
  await replaceValue(input, "[data-debug-id='task-manager-timezone']", "Europe/Riga");
  pass(NAMES.timezone, "Native input applied exact schedule timezone Europe/Riga.");
  await selectValue(input, "[data-debug-id='task-manager-missed-run-policy']", "Run once when ShellX opens", "runOnceWhenAvailable");
  pass(NAMES.missedRun, "Native choice selected the exact run-once missed-run policy.");
  await replaceValue(input, "[data-debug-id='task-manager-max-run-seconds']", "15");
  pass(NAMES.maxRun, "Native input applied an exact 15-minute maximum duration.");
  await selectValue(input, "[data-debug-id='task-manager-notification-policy']", "After every result", "everyTerminalResult");
  pass(NAMES.notifications, "Native choice selected notifications for every terminal result.");
}

async function exerciseProviderControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  pass: (name: string, detail: string) => void,
): Promise<void> {
  await selectValue(input, "[data-debug-id='task-manager-environment']", "Remote Windows · ssh / Windows", "remote-windows");
  pass(NAMES.environment, "Native environment selection changed the exact execution target and cleared the prior route.");
  await resetFixture(connection, input);

  await nativeClick(input, "[data-debug-id='task-manager-recheck']");
  await waitForReleaseSurfaceInstalledInputElement(input, FEEDBACK_ACTION);
  pass(NAMES.recheck, "Native Recheck produced a bounded owned provider-catalogue feedback state without provider execution.");

  await nativeClick(input, "[data-debug-id='task-manager-provider-codex-cli-toggle']");
  await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='task-manager-model-codex-cli']");
  pass(NAMES.toggleProvider, "Native provider activation added Codex as the second exact fallback candidate.");
  await selectValue(input, "[data-debug-id='task-manager-model-grok']", "Grok fixture fast · verified", "grok-fixture-fast");
  pass(NAMES.model, "Native model selection bound the verified Grok fixture model.");
  await nativeClick(input, "[data-debug-id='task-manager-provider-codex-cli-move-up']");
  await waitBoolean(input, "[data-debug-id='task-manager-provider-codex-cli-move-down']", "disabled", false);
  pass(NAMES.moveUp, "Native Move up changed Codex from second to first in the fallback route.");
  await nativeClick(input, "[data-debug-id='task-manager-provider-codex-cli-move-down']");
  await waitBoolean(input, "[data-debug-id='task-manager-provider-codex-cli-move-up']", "disabled", false);
  pass(NAMES.moveDown, "Native Move down restored Codex to second in the fallback route.");
  await nativeClick(input, "[data-debug-id='task-manager-provider-codex-cli-remove']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-model-codex-cli']");
  pass(NAMES.removeProvider, "Native Remove deleted only Codex from the unsaved provider route.");
}

async function exerciseRunAndFooterControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  pass: (name: string, detail: string) => void,
): Promise<void> {
  await nativeClick(input, "[data-debug-id='task-manager-acknowledge-attention']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-attention-item']");
  pass(NAMES.acknowledge, "Native Acknowledge resolved the exact owned attention item and removed its visible callout row.");

  await nativeClick(input, "[data-debug-id='task-manager-cancel-run-run-fixture-running']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, "[data-debug-id='task-manager-cancel-run-run-fixture-running']");
  pass(NAMES.cancelRun, "Native Cancel run terminalized the exact owned active occurrence as outcome unknown.");
  await nativeClick(input, "[data-debug-id='task-manager-open-run-run-fixture-completed']");
  await waitForReleaseSurfaceInstalledInputElement(input, FEEDBACK_ACTION);
  pass(NAMES.openRun, "Native Open run invoked the exact path-free owned conversation identity and returned bounded feedback.");

  await nativeClick(input, "[data-debug-id='task-manager-action-duplicate']");
  await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='task-manager-definition-task-fixture-copy']");
  await resetFixture(connection, input);
  await nativeClick(input, "[data-debug-id='task-manager-action-delete']");
  await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='task-manager-action-confirm-delete']");
  await nativeClick(input, "[data-debug-id='task-manager-action-confirm-delete']");
  await waitForReleaseSurfaceInstalledInputElement(input, EMPTY);
  await resetFixture(connection, input);
  await nativeClick(input, "[data-debug-id='task-manager-action-pause']");
  await waitBoolean(input, "[data-debug-id='task-manager-action-resume']", "disabled", false);
  await nativeClick(input, "[data-debug-id='task-manager-action-resume']");
  await waitBoolean(input, "[data-debug-id='task-manager-action-pause']", "disabled", false);
  await nativeClick(input, "[data-debug-id='task-manager-action-run-now']");
  await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='task-manager-run-run-fixture-manual']");
  await nativeClick(input, "[data-debug-id='task-manager-action-save-revision']");
  await waitForReleaseSurfaceInstalledInputElement(input, FEEDBACK_ACTION);
  pass(NAMES.actions, "Native footer actions proved duplicate, two-step delete, pause, resume, run-now, and save-revision owned transitions.");

  await resetFixture(connection, input);
  await nativeClick(input, "[data-debug-id='task-manager-open-vault']");
  await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='vault-workspace-modal']");
  pass(NAMES.openVault, "Native Open Vault opened the first-class Vault workspace without reading any secret value.");
}

async function exerciseCloseControls(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  pass: (name: string, detail: string) => void,
): Promise<void> {
  await patchUi(connection, { openModal: "close", debugTaskManagerFixture: "full", source: "final-surface-task-manager-close" });
  await waitForReleaseSurfaceInstalledInputElement(input, MANAGER);
  await waitBoolean(input, "[data-debug-id='task-manager-close']", "focused", true);
  await performReleaseSurfaceInstalledInputKeyChord(input, ["\uE008", "\uE004"]);
  await waitBoolean(input, "[data-debug-id='task-manager-action-save-revision']", "focused", true);
  await performReleaseSurfaceInstalledInputKeyChord(input, ["\uE004"]);
  await waitBoolean(input, "[data-debug-id='task-manager-close']", "focused", true);
  await performReleaseSurfaceInstalledInputKeyChord(input, ["\uE004"]);
  await waitBoolean(input, "[data-debug-id='task-manager-search']", "focused", true);
  await performReleaseSurfaceInstalledInputKeyChord(input, ["\uE008", "\uE004"]);
  await waitBoolean(input, "[data-debug-id='task-manager-close']", "focused", true);
  await nativeClick(input, "[data-debug-id='task-manager-close']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER);

  await nativeClick(input, "[data-debug-id='header-tasks']");
  await waitForReleaseSurfaceInstalledInputElement(input, MANAGER);
  await waitBoolean(input, "[data-debug-id='task-manager-close']", "focused", true);
  await performReleaseSurfaceInstalledInputKeyChord(input, ["\uE00C"]);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER);
  await waitBoolean(input, "[data-debug-id='header-tasks']", "focused", true);
  pass(NAMES.close, "Native input proved initial Close focus, forward and reverse Tab containment, pointer dismissal, Escape dismissal, and exact focus restoration to the Tasks opener.");
  await resetFixture(connection, input);
  await nativeClick(input, "[data-debug-id='task-manager-backdrop']");
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, MANAGER);
  pass(NAMES.backdrop, "Native backdrop pointer-down and click dismissed only the owned Task Manager dialog.");
}

async function resetFixture(connection: Connection, input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  await patchUi(connection, { debugTaskManagerFixture: "full", source: "final-surface-task-manager-controls" });
  await waitForReleaseSurfaceInstalledInputElement(input, MANAGER, { timeoutMs: TIMEOUT_MS });
}

async function nativeClick(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clickReleaseSurfaceInstalledInputElement(input, element);
}

async function replaceValue(input: ReleaseSurfaceInstalledInputSession, selector: string, value: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clearReleaseSurfaceInstalledInputElement(input, element);
  if (value) await setReleaseSurfaceInstalledInputElementValue(input, element, value);
  await waitValue(input, selector, value);
}

async function selectValue(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
  inputText: string,
  expectedValue = inputText,
): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clickReleaseSurfaceInstalledInputElement(input, element);
  await setReleaseSurfaceInstalledInputElementValue(input, element, inputText);
  await waitValue(input, selector, expectedValue);
}

async function waitValue(input: ReleaseSurfaceInstalledInputSession, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observation = await observeReleaseSurfaceInstalledInputElement(input, selector, ["value"]);
    if (observation.present && observation.visible && observation.value === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach exact value ${JSON.stringify(expected)}`);
}

async function waitBoolean(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
  field: "checked" | "pressed" | "disabled" | "focused",
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observation = await observeReleaseSurfaceInstalledInputElement(input, selector, [field]);
    if (observation.present && observation.visible && observation[field] === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach ${field}=${expected}`);
}

async function patchUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base.replace(/\/$/, "")}/state/ui`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Task Manager fixture patch failed with HTTP ${response.status}`);
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== TASK_MANAGER_CONTROL_SURFACE_NAMES.size) {
    throw new Error(`Task Manager control driver requires exactly ${TASK_MANAGER_CONTROL_SURFACE_NAMES.size} assignments`);
  }
  const names = new Set(assignments.map((assignment) => assignment.surface.name));
  for (const assignment of assignments) {
    if (!supportsTaskManagerControl(assignment.surface)
      || assignment.fixtureId !== TASK_MANAGER_CONTROL_FIXTURE
      || assignment.cleanupId !== TASK_MANAGER_CONTROL_CLEANUP
      || assignment.oracleId !== taskManagerControlOracle(assignment.surface)
      || !TASK_MANAGER_CONTROL_ORACLES.includes(assignment.oracleId as typeof TASK_MANAGER_CONTROL_ORACLES[number])) {
      throw new Error(`Task Manager assignment does not match its exact contract: ${assignment.surface.id}`);
    }
  }
  for (const name of TASK_MANAGER_CONTROL_SURFACE_NAMES) {
    if (!names.has(name)) throw new Error(`Task Manager control driver is missing ${name}`);
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
    observedEffect: "No native Task Manager control effect was observed.",
  };
}

function requiredOutcome(
  outcomes: Map<string, ReleaseSurfaceDriverOutcome>,
  name: string,
): ReleaseSurfaceDriverOutcome {
  const outcome = outcomes.get(name);
  if (!outcome) throw new Error(`Task Manager outcome is missing ${name}`);
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
