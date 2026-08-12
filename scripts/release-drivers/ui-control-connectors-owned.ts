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
import { apiJson, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type SettingsTab = "general" | "vault" | "connections" | "connectors" | "desktop" | "shellxagent" | "data" | "about";
type ConnectorAction = "secret-draft" | "fixed-session" | "sim-connector" | "edit-owned";

const SOURCE = "src/components/settings/ConnectorsTab.tsx";
const SECRET_SURFACE = `${SOURCE}:[id=\"connector-secret\"]`;
const FIXED_SESSION_SURFACE = `${SOURCE}:[data-debug-id=\"surface-components-settings-connectorstab-11\"]`;
const SIM_CONNECTOR_SURFACE = `${SOURCE}:[id=\"connector-sim-connector\"]`;
const EDIT_SURFACE = `${SOURCE}:role=button;name=\"Edit\"`;
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const CONNECTORS_TAB = "[data-debug-id='settings-tab-connectors']";
const FIXTURE_ROOT = "[data-connectors-debug-fixture='owned-safe']";
const NEW = "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])";
const CANCEL = "[aria-label='Cancel connector draft']";
const SECRET = "[id='connector-secret']";
const TARGET = "[id='connector-target']";
const FIXED_SESSION = "[data-debug-id='surface-components-settings-connectorstab-11']";
const SIM_CONNECTOR = "[id='connector-sim-connector']";
const EDIT_OWNED = "[data-connector-id='release-owned-connector-telegram'] .connection-row-meta > button:nth-of-type(2)";
const SAVE = "[data-debug-id='surface-components-settings-connectorstab-12']";
const SIMULATE = "[data-debug-id='surface-components-settings-connectorstab-17']";
const TEST_OWNED = "[data-connector-id='release-owned-connector-telegram'] [data-debug-id='surface-components-settings-connectorstab-18']";
const REMOVE_OWNED = "[data-connector-id='release-owned-connector-telegram'] .settings-pill-danger";
const OWNED_SECRET_DRAFT = "SHELLX_RELEASE_OWNED_CONNECTOR_TOKEN";
const OWNED_SESSION_ID = "release-owned-connector-tab";
const OWNED_SESSION_OPTION = "1 · Release owned connector session · local · idle · release-owne";
const OWNED_TELEGRAM_CONNECTOR_ID = "release-owned-connector-telegram";
const OWNED_DISCORD_CONNECTOR_ID = "release-owned-connector-discord";
const OWNED_TELEGRAM_OPTION = "Release owned Telegram · Telegram";
const OWNED_DISCORD_OPTION = "Release owned Discord · Discord";

export const CONNECTORS_OWNED_FIXTURES = ["ui:connectors-owned-renderer-fixture"] as const;
export const CONNECTORS_OWNED_CLEANUPS = ["ui:clear-connectors-owned-fixture-and-close-settings"] as const;
export const CONNECTORS_OWNED_ORACLES = ["ui:activation:owned-connector-edit-opened"] as const;

export function supportsOwnedConnectorsControl(assignment: Assignment): boolean {
  return actionForAssignment(assignment) !== null;
}

export async function exerciseOwnedConnectorsControl(
  connection: Connection,
  installedInput: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actionForAssignment(assignment);
  if (!action) return finalize(emptyOutcome(assignment, "The Connectors control is outside the owned renderer-only cohort."));
  const outcome = emptyOutcome(assignment, "No reversible owned Connectors transition was observed.");
  let baselineTab: SettingsTab | null = null;
  try {
    baselineTab = await prepareFixture(connection, installedInput);
    if (action === "secret-draft") await exerciseSecretDraft(installedInput, outcome);
    else if (action === "fixed-session") await exerciseFixedSession(installedInput, outcome);
    else if (action === "sim-connector") await exerciseSimulatorConnector(installedInput, outcome);
    else await exerciseEditOwned(installedInput, outcome);
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    applyCleanup(outcome, await cleanupFixture(connection, installedInput, baselineTab));
  }
  return finalize(outcome);
}

function actionForAssignment(assignment: Assignment): ConnectorAction | null {
  if (assignment.surface.name === SECRET_SURFACE) return "secret-draft";
  if (assignment.surface.name === FIXED_SESSION_SURFACE) return "fixed-session";
  if (assignment.surface.name === SIM_CONNECTOR_SURFACE) return "sim-connector";
  if (assignment.surface.name === EDIT_SURFACE) return "edit-owned";
  return null;
}

async function exerciseSecretDraft(installedInput: InstalledInput, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await openNewDraft(installedInput);
  const secret = await waitForReleaseSurfaceInstalledInputElement(installedInput, SECRET);
  await waitForBoundedNonempty(installedInput, SECRET, false);
  await assertUnsafeControlsDisabled(installedInput);
  outcome.present = "pass";
  await clearReleaseSurfaceInstalledInputElement(installedInput, secret);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, secret, OWNED_SECRET_DRAFT);
  outcome.invoke = "pass";
  await waitForBoundedNonempty(installedInput, SECRET, true);
  await clearReleaseSurfaceInstalledInputElement(installedInput, secret);
  await waitForBoundedNonempty(installedInput, SECRET, false);
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input changed and then cleared only the synthetic unsaved connector token field; Save stayed disabled and no Vault command was invoked.";
}

async function exerciseFixedSession(installedInput: InstalledInput, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  await openNewDraft(installedInput);
  const target = await waitForReleaseSurfaceInstalledInputElement(installedInput, TARGET);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, target, "Fixed tab id");
  const fixed = await waitForReleaseSurfaceInstalledInputElement(installedInput, FIXED_SESSION);
  await waitForBoundedValue(installedInput, TARGET, "fixedTab");
  await waitForBoundedValue(installedInput, FIXED_SESSION, "");
  outcome.present = "pass";
  await setReleaseSurfaceInstalledInputElementValue(installedInput, fixed, OWNED_SESSION_OPTION);
  outcome.invoke = "pass";
  await waitForBoundedValue(installedInput, FIXED_SESSION, OWNED_SESSION_ID);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, fixed, "Choose live session");
  await waitForBoundedValue(installedInput, FIXED_SESSION, "");
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input selected and then cleared the exact synthetic session only in the unsaved connector target draft; no live session or operator configuration changed.";
}

async function exerciseSimulatorConnector(installedInput: InstalledInput, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const simulator = await waitForReleaseSurfaceInstalledInputElement(installedInput, SIM_CONNECTOR);
  await waitForBoundedValue(installedInput, SIM_CONNECTOR, OWNED_TELEGRAM_CONNECTOR_ID);
  await assertUnsafeControlsDisabled(installedInput);
  outcome.present = "pass";
  await setReleaseSurfaceInstalledInputElementValue(installedInput, simulator, OWNED_DISCORD_OPTION);
  outcome.invoke = "pass";
  await waitForBoundedValue(installedInput, SIM_CONNECTOR, OWNED_DISCORD_CONNECTOR_ID);
  await setReleaseSurfaceInstalledInputElementValue(installedInput, simulator, OWNED_TELEGRAM_OPTION);
  await waitForBoundedValue(installedInput, SIM_CONNECTOR, OWNED_TELEGRAM_CONNECTOR_ID);
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input selected both synthetic renderer-only connector options and restored the baseline while Simulate remained disabled.";
}

async function exerciseEditOwned(installedInput: InstalledInput, outcome: ReleaseSurfaceDriverOutcome): Promise<void> {
  const edit = await waitForReleaseSurfaceInstalledInputElement(installedInput, EDIT_OWNED);
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SECRET);
  await assertUnsafeControlsDisabled(installedInput);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(installedInput, edit);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(installedInput, SECRET);
  await assertUnsafeControlsDisabled(installedInput);
  const cancel = await waitForReleaseSurfaceInstalledInputElement(installedInput, CANCEL);
  await clickReleaseSurfaceInstalledInputElement(installedInput, cancel);
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SECRET);
  outcome.effect = "pass";
  outcome.observedEffect = "A native installed click opened the exact synthetic connector in the local editor and Cancel restored the closed fixture without saving or reading Vault state.";
}

async function prepareFixture(connection: Connection, installedInput: InstalledInput): Promise<SettingsTab> {
  const baselineTab = await readSettingsTab(connection);
  await postUi(connection, {
    openModal: "close",
    debugConnectorsFixture: "clear",
    source: "final-surface-owned-connectors-baseline",
  });
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SETTINGS_DIALOG);
  await postUi(connection, {
    debugConnectorsFixture: "owned-safe",
    openModal: "settings",
    source: "final-surface-owned-connectors-fixture",
  });
  await waitForReleaseSurfaceInstalledInputElement(installedInput, SETTINGS_DIALOG);
  const tab = await waitForReleaseSurfaceInstalledInputElement(installedInput, CONNECTORS_TAB);
  await clickReleaseSurfaceInstalledInputElement(installedInput, tab);
  await waitForReleaseSurfaceInstalledInputElement(installedInput, `${CONNECTORS_TAB}[aria-selected='true']`);
  await waitForReleaseSurfaceInstalledInputElement(installedInput, FIXTURE_ROOT);
  await waitForFixtureMounted(installedInput);
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SECRET);
  await waitForBoundedValue(installedInput, SIM_CONNECTOR, OWNED_TELEGRAM_CONNECTOR_ID);
  await assertUnsafeControlsDisabled(installedInput);
  return baselineTab;
}

async function openNewDraft(installedInput: InstalledInput): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(installedInput, SECRET)) {
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, NEW);
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  }
  await waitForReleaseSurfaceInstalledInputElement(installedInput, SECRET);
  await assertUnsafeControlsDisabled(installedInput);
}

async function cleanupFixture(
  connection: Connection,
  installedInput: InstalledInput,
  baselineTab: SettingsTab | null,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const secret = await findReleaseSurfaceInstalledInputElement(installedInput, SECRET);
    if (secret) await clearReleaseSurfaceInstalledInputElement(installedInput, secret);
    const cancel = await findReleaseSurfaceInstalledInputElement(installedInput, CANCEL);
    if (cancel) await clickReleaseSurfaceInstalledInputElement(installedInput, cancel);
    if (await findReleaseSurfaceInstalledInputElement(installedInput, FIXTURE_ROOT)) {
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SECRET);
      await waitForBoundedValue(installedInput, SIM_CONNECTOR, OWNED_TELEGRAM_CONNECTOR_ID);
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    if (baselineTab && await findReleaseSurfaceInstalledInputElement(installedInput, SETTINGS_DIALOG)) {
      const selector = `[data-debug-id='settings-tab-${baselineTab}']`;
      const tab = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
      await clickReleaseSurfaceInstalledInputElement(installedInput, tab);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, `${selector}[aria-selected='true']`);
    }
    await postUi(connection, {
      openModal: "close",
      debugConnectorsFixture: "clear",
      source: "final-surface-owned-connectors-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, SETTINGS_DIALOG);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, FIXTURE_ROOT);
  } catch (error) {
    errors.push(errorText(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function readSettingsTab(connection: Connection): Promise<SettingsTab> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const tab = String(state.settingsTab ?? "general");
  if (!["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"].includes(tab)) {
    throw new Error("Debug UI state did not expose a supported Settings baseline tab");
  }
  return tab as SettingsTab;
}

async function waitForFixtureMounted(installedInput: InstalledInput): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, FIXTURE_ROOT, ["mounted"]);
    if (state.present && state.visible && state.mounted === true) return;
    await delay(50);
  }
  throw new Error("owned Connectors renderer fixture did not expose its bounded mounted state");
}

async function waitForBoundedValue(installedInput: InstalledInput, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["value"]);
    if (state.present && state.visible && state.value === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach its exact bounded value`);
}

async function waitForBoundedNonempty(installedInput: InstalledInput, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["nonempty"]);
    if (state.present && state.visible && state.nonempty === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach its value-blind bounded state`);
}

async function assertUnsafeControlsDisabled(installedInput: InstalledInput): Promise<void> {
  let observed = 0;
  for (const selector of [SAVE, SIMULATE, TEST_OWNED, REMOVE_OWNED]) {
    const state = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["disabled"]);
    if (!state.present) continue;
    if (!state.visible || state.disabled !== true) {
      throw new Error(`${selector} was not bounded and disabled in the owned Connectors fixture`);
    }
    observed += 1;
  }
  if (observed < 3) throw new Error("owned Connectors fixture exposed fewer than three bounded mutation locks");
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
    outcome.error = "owned Connectors control did not satisfy every renderer-only lifecycle verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
