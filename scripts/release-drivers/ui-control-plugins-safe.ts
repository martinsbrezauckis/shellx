import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
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
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type PluginsAction = "installed-key-toggle" | "available-key-toggle" | "key-draft";

const TOGGLE_SURFACE = "src/components/PluginsModal.tsx::is([title=\"Cancel adding key (clears input)\"],[title=\"Enter your API key inline\"])";
const INPUT_SURFACE = "src/components/PluginsModal.tsx:[data-debug-id=\"plugins-vault-key-input\"]";
const DIALOG = "[role='dialog'][aria-label='Plugins']";
const INPUT = "[data-debug-id='plugins-vault-key-input']";
const FORM_BY_ACTION: Readonly<Record<Exclude<PluginsAction, "key-draft">, string>> = {
  "installed-key-toggle": "#mcp-key-form-release-owned-installed-key",
  "available-key-toggle": "#mcp-key-form-release-owned-uninstalled-key",
};
const OWNED_DRAFT = "synthetic-release-owned-plugin-draft";
const CONTROL_BY_ACTION: Readonly<Record<Exclude<PluginsAction, "key-draft">, string>> = {
  "installed-key-toggle": "[data-marketplace-entry-id='release-owned-installed-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])",
  "available-key-toggle": "[data-marketplace-entry-id='release-owned-uninstalled-key'] :is([title='Cancel adding key (clears input)'],[title='Enter your API key inline'])",
};

export const PLUGINS_SAFE_FIXTURES = ["ui:plugins-owned-local-draft"] as const;
export const PLUGINS_SAFE_CLEANUPS = ["ui:clear-owned-plugin-draft-and-fixture"] as const;
export const PLUGINS_SAFE_ORACLES = [] as const;

export function supportsPluginsSafeControl(assignment: Assignment): boolean {
  return actionForAssignment(assignment) !== null;
}

export async function exercisePluginsSafeControl(
  connection: Connection,
  installedInput: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actionForAssignment(assignment);
  if (action === "installed-key-toggle" || action === "available-key-toggle") {
    return exerciseToggle(connection, installedInput, assignment, action);
  }
  if (action === "key-draft") return exerciseDraft(connection, installedInput, assignment);
  return finalize(emptyOutcome(assignment, "The Plugins control is outside the safe local-draft cohort."));
}

function actionForAssignment(assignment: Assignment): PluginsAction | null {
  if (assignment.surface.name === INPUT_SURFACE && assignment.surface.id.endsWith("#12")) return "key-draft";
  if (assignment.surface.name !== TOGGLE_SURFACE) return null;
  if (assignment.surface.id.endsWith("#6")) return "installed-key-toggle";
  if (assignment.surface.id.endsWith("#9")) return "available-key-toggle";
  return null;
}

async function exerciseToggle(
  connection: Connection,
  installedInput: InstalledInput,
  assignment: Assignment,
  action: Exclude<PluginsAction, "key-draft">,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No reversible Plugins key-form transition was observed.");
  const selector = CONTROL_BY_ACTION[action];
  try {
    await prepareFixture(connection, installedInput);
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
    await expectExpanded(installedInput, selector, false);
    outcome.present = "pass";

    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    outcome.invoke = "pass";
    await expectExpanded(installedInput, selector, true);
    const input = await waitForReleaseSurfaceInstalledInputElement(installedInput, INPUT);
    await clearReleaseSurfaceInstalledInputElement(installedInput, input);
    await setReleaseSurfaceInstalledInputElementValue(installedInput, input, OWNED_DRAFT);
    await expectDraftState(installedInput, FORM_BY_ACTION[action], "Draft present");

    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await expectExpanded(installedInput, selector, false);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, INPUT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await expectExpanded(installedInput, selector, true);
    await expectDraftState(installedInput, FORM_BY_ACTION[action], "Draft empty");
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    await expectExpanded(installedInput, selector, false);
    outcome.effect = "pass";
    outcome.observedEffect = "Native installed input opened and cancelled the exact owned in-memory Plugins key form, then proved its synthetic draft was cleared on reopen without invoking marketplace or Vault commands.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    applyCleanup(outcome, await cleanupFixture(connection, installedInput, selector));
  }
  return finalize(outcome);
}

async function exerciseDraft(
  connection: Connection,
  installedInput: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No local Plugins key-draft value transition was observed.");
  const selector = CONTROL_BY_ACTION["available-key-toggle"];
  try {
    await prepareFixture(connection, installedInput);
    const toggle = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
    await clickReleaseSurfaceInstalledInputElement(installedInput, toggle);
    await expectExpanded(installedInput, selector, true);
    const input = await waitForReleaseSurfaceInstalledInputElement(installedInput, INPUT);
    await expectDraftState(installedInput, FORM_BY_ACTION["available-key-toggle"], "Draft empty");
    outcome.present = "pass";

    await clearReleaseSurfaceInstalledInputElement(installedInput, input);
    await setReleaseSurfaceInstalledInputElementValue(installedInput, input, OWNED_DRAFT);
    outcome.invoke = "pass";
    await expectDraftState(installedInput, FORM_BY_ACTION["available-key-toggle"], "Draft present");
    outcome.effect = "pass";
    outcome.observedEffect = "Native installed input wrote only a synthetic value into the owned in-memory Plugins key draft; no Save, marketplace, Vault, provider, or clipboard action was invoked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    applyCleanup(outcome, await cleanupFixture(connection, installedInput, selector));
  }
  return finalize(outcome);
}

async function prepareFixture(connection: Connection, installedInput: InstalledInput): Promise<void> {
  await postUi(connection, {
    openModal: "close",
    debugPluginsFixture: "clear",
    source: "final-surface-owned-plugins-baseline",
  });
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
  await postUi(connection, {
    debugPluginsFixture: "owned-safe",
    openModal: "plugins",
    source: "final-surface-owned-plugins-draft",
  });
  await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);
}

async function cleanupFixture(
  connection: Connection,
  installedInput: InstalledInput,
  selector: string,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    if (await findReleaseSurfaceInstalledInputElement(installedInput, INPUT)) {
      const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
      await clickReleaseSurfaceInstalledInputElement(installedInput, control);
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, INPUT);
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    await postUi(connection, {
      openModal: "close",
      debugPluginsFixture: "clear",
      source: "final-surface-owned-plugins-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, INPUT);
  } catch (error) {
    errors.push(errorText(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function expectExpanded(installedInput: InstalledInput, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["expanded"]);
    if (state.present && state.visible && state.expanded === expected) return;
    await delay(50);
  }
  throw new Error(`owned Plugins key-form expanded state did not become ${String(expected)}`);
}

async function expectDraftState(installedInput: InstalledInput, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["title"]);
    if (state.present && state.visible && state.title === expected) return;
    await delay(50);
  }
  throw new Error(`owned Plugins key form did not reach ${expected}`);
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

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, cleanupError: string | null): void {
  if (!cleanupError) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Plugins control did not satisfy every safe local-draft verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
