import { isDeepStrictEqual } from "node:util";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
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

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type Preset = Record<string, unknown> & {
  id: string;
  label: string;
  transport: { kind: string };
};
type Fixture = {
  baselineJson: string;
  baselineUi: { activeTabId: string; activeTab: Record<string, unknown> };
  id: string;
  label: string;
  saved: Preset;
};

const PREFIX = "src/components/";
const SAVE = `${PREFIX}ConnectionEditor.tsx:[data-debug-id="surface-components-connectioneditor-16"]`;
const EDITOR_SCAN = `${PREFIX}ConnectionEditor.tsx:[data-debug-id="surface-components-connectioneditor-12"]`;
const EDITOR_TEST = `${PREFIX}ConnectionEditor.tsx:[data-debug-id="surface-components-connectioneditor-14"]`;
const EDITOR_SETUP = `${PREFIX}ConnectionEditor.tsx:[data-debug-id="connection-agent-cli-setup-open"]`;
const EDIT = `${PREFIX}ConnectionPicker.tsx:role=button;name="Edit"`;
const USE = `${PREFIX}ConnectionPicker.tsx:[title^="Use "]`;
const PICKER_TEST = `${PREFIX}ConnectionPicker.tsx:role=button;name="Test"`;
const DELETE = `${PREFIX}ConnectionPicker.tsx:[aria-label^="Delete "]`;
const CANCEL_DELETE = `${PREFIX}ConnectionPicker.tsx:role=button;name="Cancel"`;
const CONFIRM_DELETE = `${PREFIX}ConnectionPicker.tsx:[aria-label="Confirm delete connection"]`;
const SETTINGS_REFRESH = `${PREFIX}settings/ConnectionsTab.tsx:[data-debug-id="surface-components-settings-connectionstab-2"]`;
const SETTINGS_EDIT = `${PREFIX}settings/ConnectionsTab.tsx:[title="Edit this connection"]`;
const SETTINGS_DELETE = `${PREFIX}settings/ConnectionsTab.tsx:[title="Delete this connection preset"]`;
const SETTINGS_CANCEL_DELETE = `${PREFIX}settings/ConnectionsTab.tsx:[aria-label="Cancel delete connection"]`;
const SETTINGS_CONFIRM_DELETE = `${PREFIX}settings/ConnectionsTab.tsx:[aria-label="Confirm delete saved connection"]`;
const SUPPORTED = new Set([
  SAVE,
  EDITOR_SCAN,
  EDITOR_TEST,
  EDITOR_SETUP,
  EDIT,
  USE,
  PICKER_TEST,
  DELETE,
  CANCEL_DELETE,
  CONFIRM_DELETE,
  SETTINGS_REFRESH,
  SETTINGS_EDIT,
  SETTINGS_DELETE,
  SETTINGS_CANCEL_DELETE,
  SETTINGS_CONFIRM_DELETE,
]);
const PICKER_TOGGLE = "[data-debug-id='composer-connection']";
const PICKER = "[role='dialog'][aria-label='Saved connections']";
const EDITOR = "[role='dialog'][aria-labelledby='conn-editor-title']";
const LABEL_INPUT = "[data-debug-id='connection-label-input']";
const SAVE_BUTTON = "[data-debug-id='surface-components-connectioneditor-16']";
const CLOSE_EDITOR = "[aria-label='Close connection editor']";
const DELETE_CONFIRMATION = "[role='alertdialog'][aria-label='Delete connection']";
const DELETE_CANCEL_BUTTON = "[role='alertdialog'][aria-label='Delete connection'] button:nth-of-type(1)";
const DELETE_CONFIRM_BUTTON = "[aria-label='Confirm delete connection']";
const SETTINGS = "[data-debug-id='surface-components-settings-1']";
const SETTINGS_CONNECTION_TAB = "[data-debug-id='settings-tab-connections']";
const SETTINGS_REFRESH_BUTTON = "[data-debug-id='surface-components-settings-connectionstab-2']";
const SETTINGS_DELETE_CONFIRMATION = "[role='alertdialog'][aria-label='Delete saved connection']";
const SETTINGS_DELETE_CANCEL_BUTTON = "[aria-label='Cancel delete connection']";
const SETTINGS_DELETE_CONFIRM_BUTTON = "[aria-label='Confirm delete saved connection']";
const PROVIDER_SCAN_RECEIPT = "[data-shellx-release-control='connection-provider-scan-receipt']";
const EDITOR_TEST_RECEIPT = "[data-shellx-release-control='connection-test-receipt']";
const AGENT_CLI_SETUP_DIALOG = "[data-debug-id='agent-cli-setup-assistant']";
const AGENT_CLI_SETUP_GROK_CARD = ".agent-cli-setup-card[data-agent-cli-provider='grok']";
const AGENT_CLI_SETUP_CLOSE = "[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:last-child";

export const CONNECTION_LIFECYCLE_FIXTURES = [
  "ui:owned-connection-record-picker",
  "ui:owned-connection-record-edit",
  "ui:owned-connection-record-settings",
  "ui:owned-connection-record-local-probe",
] as const;

export const CONNECTION_LIFECYCLE_CLEANUPS = [
  "ui:close-connection-ui-delete-owned-record-restore-directory",
] as const;

export const CONNECTION_LIFECYCLE_ORACLES = [
  "ui:activation:owned-connection-editor-opened",
  "ui:activation:owned-connection-record-saved",
  "ui:activation:owned-connection-delete-confirmation-opened",
  "ui:activation:owned-connection-delete-cancelled",
  "ui:activation:owned-connection-record-deleted",
  "ui:activation:owned-connection-directory-refreshed",
  "ui:activation:owned-connection-provider-scan-completed",
  "ui:activation:owned-connection-test-completed",
  "ui:activation:owned-connection-selected",
  "ui:activation:owned-connection-agent-setup-opened",
] as const;

export function supportsConnectionLifecycleControl(assignment: Assignment): boolean {
  return SUPPORTED.has(assignment.surface.name);
}

export async function exerciseConnectionLifecycleControl(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let fixture: Fixture | null = null;
  try {
    assertAssignmentContract(assignment);
    await requireClosedBaseline(input);
    fixture = await prepareOwnedFixture(connection, request);
    if (assignment.surface.name === EDIT) await exerciseEdit(connection, input, fixture, outcome);
    else if (assignment.surface.name === USE) await exerciseUse(connection, input, fixture, outcome);
    else if (assignment.surface.name === PICKER_TEST) await exercisePickerTest(connection, input, fixture, outcome);
    else if (assignment.surface.name === EDITOR_SCAN) await exerciseEditorScan(connection, input, fixture, outcome);
    else if (assignment.surface.name === EDITOR_TEST) await exerciseEditorTest(connection, input, fixture, outcome);
    else if (assignment.surface.name === EDITOR_SETUP) await exerciseEditorSetup(connection, input, fixture, outcome);
    else if (assignment.surface.name === SAVE) await exerciseSave(connection, input, fixture, outcome);
    else if (assignment.surface.name === DELETE) await exerciseDeletePrompt(connection, input, fixture, outcome);
    else if (assignment.surface.name === CANCEL_DELETE) await exerciseDeleteCancel(connection, input, fixture, outcome);
    else if (assignment.surface.name === CONFIRM_DELETE) await exerciseDeleteConfirm(connection, input, fixture, outcome);
    else if (assignment.surface.name === SETTINGS_REFRESH) await exerciseSettingsRefresh(connection, input, fixture, outcome);
    else if (assignment.surface.name === SETTINGS_EDIT) await exerciseSettingsEdit(connection, input, fixture, outcome);
    else if (assignment.surface.name === SETTINGS_DELETE) await exerciseSettingsDeletePrompt(connection, input, fixture, outcome);
    else if (assignment.surface.name === SETTINGS_CANCEL_DELETE) await exerciseSettingsDeleteCancel(connection, input, fixture, outcome);
    else if (assignment.surface.name === SETTINGS_CONFIRM_DELETE) await exerciseSettingsDeleteConfirm(connection, input, fixture, outcome);
    else throw new Error(`unsupported connection lifecycle control ${assignment.surface.name}`);
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanup(connection, input, fixture));
  }
  return finalize(outcome);
}

async function exerciseEdit(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openPicker(input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, editSelector(fixture.label));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, EDITOR);
  const directory = await connectionDirectory(connection);
  if (directory.presets.length === 0 || !directory.presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("owned connection edit activation changed its directory record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native click on the exact label-addressed owned row opened ConnectionEditor while its directory record remained state-exact; no provider, Vault, transport, or save action ran.";
}

async function exerciseUse(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openPicker(input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, useSelector(fixture.label));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, PICKER);
  await waitForConnectionUi(connection, (state) => {
    const active = asRecord(state.activeTab);
    return active?.connectionId === fixture.id
      && active.connectionLabel === fixture.label
      && active.connectionTransport === "local";
  }, "owned active connection selection");
  await waitForOwnedProviderScan(connection, fixture.id);
  outcome.effect = "pass";
  outcome.observedEffect = "A native Use click selected only the exact disposable local preset on the active tab and completed the real provider version/hash scan before cleanup restored the original tab state.";
}

async function exercisePickerTest(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openPicker(input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, pickerTestSelector(fixture.label));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForTestReceipt(input, pickerTestReceiptSelector(fixture.label));
  await waitForOwnedProviderScan(connection, fixture.id);
  outcome.effect = "pass";
  outcome.observedEffect = "A native picker Test click ran the exact disposable local connection probe, rendered its reachable/error result, and persisted a fresh four-provider version/hash snapshot only on that owned preset.";
}

async function exerciseEditorScan(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openOwnedEditor(input, fixture);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='surface-components-connectioneditor-12']");
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForProviderScanReceipt(input);
  const unchanged = (await connectionDirectory(connection)).presets.find((preset) => preset.id === fixture.id);
  if (!unchanged || !isDeepStrictEqual(unchanged, fixture.saved)) {
    throw new Error("editor Scan CLIs persisted or changed the owned preset before Save");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Scan CLIs click ran the real local provider discovery/version/hash probe and rendered all four provider rows without persisting the unsaved editor result.";
}

async function exerciseEditorTest(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openOwnedEditor(input, fixture);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='surface-components-connectioneditor-14']");
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForTestReceipt(input, EDITOR_TEST_RECEIPT);
  await waitForOwnedProviderScan(connection, fixture.id);
  outcome.effect = "pass";
  outcome.observedEffect = "A native editor Test click ran the real disposable local connection probe, rendered its bounded result, and persisted a fresh four-provider version/hash snapshot only on the owned preset.";
}

async function exerciseEditorSetup(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openOwnedEditor(input, fixture);
  const scan = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='surface-components-connectioneditor-12']");
  await clickReleaseSurfaceInstalledInputElement(input, scan);
  await waitForProviderScanReceipt(input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='connection-agent-cli-setup-open']", {
    timeoutMs: 30_000,
    pollMs: 100,
  });
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, AGENT_CLI_SETUP_DIALOG, {
    timeoutMs: 30_000,
    pollMs: 100,
  });
  await waitForReleaseSurfaceInstalledInputElement(input, AGENT_CLI_SETUP_GROK_CARD, {
    timeoutMs: 30_000,
    pollMs: 100,
  });
  outcome.effect = "pass";
  outcome.observedEffect = "Native installed input completed the real owned local provider scan and opened the connection-scoped Agent CLI setup assistant with its inspected provider cards; no install method was prepared or confirmed.";
}

async function openOwnedEditor(
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
): Promise<void> {
  await openPicker(input);
  const edit = await waitForReleaseSurfaceInstalledInputElement(input, editSelector(fixture.label));
  await clickReleaseSurfaceInstalledInputElement(input, edit);
  await waitForReleaseSurfaceInstalledInputElement(input, EDITOR);
}

async function exerciseSave(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openPicker(input);
  const edit = await waitForReleaseSurfaceInstalledInputElement(input, editSelector(fixture.label));
  await clickReleaseSurfaceInstalledInputElement(input, edit);
  await waitForReleaseSurfaceInstalledInputElement(input, EDITOR);
  const nextLabel = `${fixture.label} saved`;
  const labelInput = await waitForReleaseSurfaceInstalledInputElement(input, LABEL_INPUT);
  await clearReleaseSurfaceInstalledInputElement(input, labelInput);
  await setReleaseSurfaceInstalledInputElementValue(input, labelInput, nextLabel);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, SAVE_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, EDITOR);
  await waitForReleaseSurfaceInstalledInputElement(input, PICKER);
  const directory = await connectionDirectory(connection);
  const changed = directory.presets.find((preset) => preset.id === fixture.id);
  if (!changed || !isDeepStrictEqual(changed, { ...fixture.saved, label: nextLabel })) {
    throw new Error("owned connection save changed fields outside the exact label transition");
  }
  fixture.label = nextLabel;
  fixture.saved = changed;
  outcome.effect = "pass";
  outcome.observedEffect = "Native label input plus Save changed only the exact owned local preset label and reopened Saved connections; all other preset fields remained byte-for-state equal.";
}

async function exerciseDeletePrompt(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openDeleteConfirmation(input, fixture);
  outcome.present = "pass";
  outcome.invoke = "pass";
  const directory = await connectionDirectory(connection);
  if (!directory.presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("opening owned connection deletion confirmation changed its directory record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native click opened the bounded in-app delete confirmation for the exact owned preset while its directory record remained state-exact.";
}

async function exerciseDeleteCancel(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openDeleteConfirmation(input, fixture);
  const cancel = await waitForReleaseSurfaceInstalledInputElement(input, DELETE_CANCEL_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, cancel);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, DELETE_CONFIRMATION);
  const directory = await connectionDirectory(connection);
  if (!directory.presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("cancelling owned connection deletion changed its directory record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native click cancelled the bounded in-app delete confirmation and preserved the exact owned preset without changing the connection directory.";
}

async function exerciseDeleteConfirm(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openDeleteConfirmation(input, fixture);
  const confirm = await waitForReleaseSurfaceInstalledInputElement(input, DELETE_CONFIRM_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, confirm);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, DELETE_CONFIRMATION);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, deleteSelector(fixture.label));
  const restored = await apiText(connection, "GET", "/connections");
  if (restored !== fixture.baselineJson) throw new Error("owned connection delete did not restore the exact directory bytes");
  outcome.effect = "pass";
  outcome.observedEffect = "A native click confirmed the bounded in-app deletion and removed only the owned disposable preset before exact directory restoration.";
}

async function openDeleteConfirmation(
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
): Promise<void> {
  await openPicker(input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, deleteSelector(fixture.label));
  await clickReleaseSurfaceInstalledInputElement(input, control);
  await waitForReleaseSurfaceInstalledInputElement(input, DELETE_CONFIRMATION);
}

async function exerciseSettingsRefresh(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openSettingsConnections(connection, input, fixture);
  await apiJson(connection, "DELETE", "/connections/" + encodeURIComponent(fixture.id));
  await waitForReleaseSurfaceInstalledInputElement(input, settingsRow(fixture.id));
  const control = await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_REFRESH_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, settingsRow(fixture.id));
  if (await apiText(connection, "GET", "/connections") !== fixture.baselineJson) {
    throw new Error("settings Refresh did not converge on the exact isolated connection directory");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Refresh click discarded one deliberately stale owned row and rendered the byte-exact isolated connection directory.";
}

async function exerciseSettingsEdit(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openSettingsConnections(connection, input, fixture);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, settingsEdit(fixture.id));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, EDITOR);
  if (!(await connectionDirectory(connection)).presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("settings Edit activation changed the exact owned connection record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native click on the exact owned Settings row opened ConnectionEditor without changing the isolated connection record.";
}

async function exerciseSettingsDeletePrompt(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openSettingsDeleteConfirmation(connection, input, fixture);
  outcome.present = "pass";
  outcome.invoke = "pass";
  if (!(await connectionDirectory(connection)).presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("opening Settings deletion confirmation changed the exact owned connection record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Settings-row Delete click opened the bounded in-app confirmation without changing the owned preset.";
}

async function exerciseSettingsDeleteCancel(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openSettingsDeleteConfirmation(connection, input, fixture);
  const cancel = await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DELETE_CANCEL_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, cancel);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DELETE_CONFIRMATION);
  if (!(await connectionDirectory(connection)).presets.some((preset) => isDeepStrictEqual(preset, fixture.saved))) {
    throw new Error("cancelling Settings deletion changed the exact owned connection record");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Cancel click closed the Settings deletion confirmation and preserved the exact owned preset.";
}

async function exerciseSettingsDeleteConfirm(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  await openSettingsDeleteConfirmation(connection, input, fixture);
  const confirm = await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DELETE_CONFIRM_BUTTON);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, confirm);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DELETE_CONFIRMATION);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, settingsRow(fixture.id));
  if (await apiText(connection, "GET", "/connections") !== fixture.baselineJson) {
    throw new Error("settings Delete did not restore the exact isolated connection directory");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native confirmation click removed only the owned Settings preset and restored the directory byte-for-byte.";
}

async function openSettingsDeleteConfirmation(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
): Promise<void> {
  await openSettingsConnections(connection, input, fixture);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, settingsDelete(fixture.id));
  await clickReleaseSurfaceInstalledInputElement(input, control);
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DELETE_CONFIRMATION);
}

async function prepareOwnedFixture(connection: Connection, request: ReleaseSurfaceDriverRequest): Promise<Fixture> {
  const baselineJson = await apiText(connection, "GET", "/connections");
  const ui = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const activeTab = asRecord(ui.activeTab);
  if (typeof ui.activeTabId !== "string" || !activeTab || activeTab.tabId !== ui.activeTabId) {
    throw new Error("connection lifecycle could not capture an exact active-tab baseline");
  }
  const baselineUi = {
    activeTabId: ui.activeTabId,
    activeTab: structuredClone(activeTab),
  };
  const baseline = parseDirectory(baselineJson);
  const label = `ShellX release owned connection ${request.sourceCommit.slice(0, 16)}`;
  if (baseline.presets.some((preset) => preset.label === label || preset.id.includes(request.sourceCommit.slice(0, 16)))) {
    throw new Error("owned connection fixture identity already exists");
  }
  const saved = await apiJson<Preset>(connection, "POST", "/connections", {
    id: "",
    label,
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
    providerScan: [],
  });
  if (!saved.id || saved.label !== label || saved.transport?.kind !== "local") {
    throw new Error("owned local connection fixture was not saved exactly");
  }
  const changed = await connectionDirectory(connection);
  if (changed.presets.length !== baseline.presets.length + 1
    || !changed.presets.some((preset) => isDeepStrictEqual(preset, saved))) {
    throw new Error("owned connection setup changed more than one directory record");
  }
  return { baselineJson, baselineUi, id: saved.id, label, saved };
}

async function cleanup(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const setup = await optionalElement(input, AGENT_CLI_SETUP_CLOSE);
    if (setup) await clickReleaseSurfaceInstalledInputElement(input, setup);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, AGENT_CLI_SETUP_DIALOG, { timeoutMs: 3_000, pollMs: 50 });
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    const editor = await optionalElement(input, CLOSE_EDITOR);
    if (editor) await clickReleaseSurfaceInstalledInputElement(input, editor);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, EDITOR, { timeoutMs: 3_000, pollMs: 50 });
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    await postUi(connection, { openModal: "close" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS, { timeoutMs: 3_000, pollMs: 50 });
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    await postUi(connection, {
      activeTabId: fixture.baselineUi.activeTabId,
      activeTab: fixture.baselineUi.activeTab,
    });
    const restored = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    if (restored.activeTabId !== fixture.baselineUi.activeTabId
      || !isDeepStrictEqual(asRecord(restored.activeTab), fixture.baselineUi.activeTab)) {
      errors.push("active tab did not return to its exact connection baseline");
    }
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    const current = await connectionDirectory(connection);
    if (current.presets.some((preset) => preset.id === fixture.id)) {
      await apiJson(connection, "DELETE", `/connections/${encodeURIComponent(fixture.id)}`);
    }
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    const picker = await optionalElement(input, PICKER);
    if (picker) {
      const toggle = await waitForReleaseSurfaceInstalledInputElement(input, PICKER_TOGGLE);
      await clickReleaseSurfaceInstalledInputElement(input, toggle);
    }
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, PICKER, { timeoutMs: 3_000, pollMs: 50 });
  } catch (error) { errors.push(errorMessage(error)); }
  try {
    const restored = await apiText(connection, "GET", "/connections");
    if (restored !== fixture.baselineJson) errors.push("connection directory was not restored byte-for-byte");
  } catch (error) { errors.push(errorMessage(error)); }
  return errors.length ? errors.join("; ") : null;
}

async function requireClosedBaseline(input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  if (await optionalElement(input, PICKER) || await optionalElement(input, EDITOR) || await optionalElement(input, SETTINGS)) {
    throw new Error("connection lifecycle fixture refuses an already-open picker, editor, or Settings dialog");
  }
}

async function openSettingsConnections(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  fixture: Fixture,
): Promise<void> {
  await postUi(connection, { openModal: "settings", debugClick: SETTINGS_CONNECTION_TAB });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS);
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_CONNECTION_TAB + "[aria-selected='true']");
  await waitForReleaseSurfaceInstalledInputElement(input, settingsRow(fixture.id));
}

async function openPicker(input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  const toggle = await waitForReleaseSurfaceInstalledInputElement(input, PICKER_TOGGLE);
  await clickReleaseSurfaceInstalledInputElement(input, toggle);
  await waitForReleaseSurfaceInstalledInputElement(input, PICKER);
}

async function waitForProviderScanReceipt(input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const receipt = await observeReleaseSurfaceInstalledInputElement(input, PROVIDER_SCAN_RECEIPT, ["title"]);
    last = receipt.title;
    if (receipt.present && receipt.visible
      && typeof last === "string"
      && /^Provider scan · transport=local · providers=4 · ready=\d+$/.test(last)) return;
    await delay(100);
  }
  throw new Error(`connection provider scan receipt did not complete: ${last ?? "missing"}`);
}

async function waitForTestReceipt(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const receipt = await observeReleaseSurfaceInstalledInputElement(input, selector, ["title"]);
    last = receipt.title;
    if (receipt.present && receipt.visible
      && typeof last === "string"
      && /^Connection test · reachable=(true|false) · latencyMs=(none|\d+) · error=(none|present)$/.test(last)) return;
    await delay(100);
  }
  throw new Error(`connection test receipt did not complete: ${last ?? "missing"}`);
}

async function waitForOwnedProviderScan(connection: Connection, id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const preset = (await connectionDirectory(connection)).presets.find((entry) => entry.id === id);
    last = preset?.providerScan;
    if (Array.isArray(last)
      && last.length === 4
      && new Set(last.map((entry) => asRecord(entry)?.providerId)).size === 4
      && last.every((entry) => {
        const row = asRecord(entry);
        return row && typeof row.checkedAtMs === "number"
          && row.status === "ready" && row.canRun === true
          && typeof row.version === "string" && row.version.length > 0
          && typeof row.binarySha256 === "string" && /^[0-9a-f]{64}$/.test(row.binarySha256)
          && typeof row.binaryBytes === "number" && row.binaryBytes > 0
          && typeof row.targetKey === "string" && row.targetKey.length > 0;
      })) return;
    await delay(100);
  }
  throw new Error(`owned connection did not persist a complete four-provider scan: ${JSON.stringify(last)}`);
}

async function waitForConnectionUi(
  connection: Connection,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    if (predicate(state)) return;
    await delay(50);
  }
  throw new Error(`connection UI did not reach ${label}`);
}

async function optionalElement(input: ReleaseSurfaceInstalledInputSession, selector: string) {
  try {
    return await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 150, pollMs: 50 });
  } catch {
    return null;
  }
}

function editSelector(label: string): string {
  return `[title='Use ${cssLabel(label)}'] ~ [data-debug-id='surface-components-connectionpicker-3'] > button:nth-of-type(2)`;
}

function useSelector(label: string): string {
  return `[title='Use ${cssLabel(label)}']`;
}

function pickerTestSelector(label: string): string {
  return `${useSelector(label)} ~ [data-debug-id='surface-components-connectionpicker-3'] > button:first-child`;
}

function pickerTestReceiptSelector(label: string): string {
  return `${useSelector(label)} [data-shellx-release-control='connection-test-receipt']`;
}

function deleteSelector(label: string): string {
  return `[aria-label='Delete ${cssLabel(label)}']`;
}

function settingsRow(id: string): string {
  return ".connection-row[data-connection-id='" + cssLabel(id) + "']";
}

function settingsEdit(id: string): string {
  return settingsRow(id) + " [title='Edit this connection']";
}

function settingsDelete(id: string): string {
  return settingsRow(id) + " [title='Delete this connection preset']";
}

function cssLabel(value: string): string {
  if (value.includes("'") || value.includes("\\")) throw new Error("owned connection label is not CSS-attribute safe");
  return value;
}

function assertAssignmentContract(assignment: Assignment): void {
  const contract = assignment.surface.name === EDIT
    ? ["ui:owned-connection-record-picker", "ui:activation:owned-connection-editor-opened"]
    : assignment.surface.name === USE
      ? ["ui:owned-connection-record-local-probe", "ui:activation:owned-connection-selected"]
    : assignment.surface.name === PICKER_TEST
      ? ["ui:owned-connection-record-local-probe", "ui:activation:owned-connection-test-completed"]
    : assignment.surface.name === EDITOR_SCAN
      ? ["ui:owned-connection-record-local-probe", "ui:activation:owned-connection-provider-scan-completed"]
    : assignment.surface.name === EDITOR_TEST
      ? ["ui:owned-connection-record-local-probe", "ui:activation:owned-connection-test-completed"]
    : assignment.surface.name === EDITOR_SETUP
      ? ["ui:owned-connection-record-local-probe", "ui:activation:owned-connection-agent-setup-opened"]
    : assignment.surface.name === SAVE
      ? ["ui:owned-connection-record-edit", "ui:activation:owned-connection-record-saved"]
      : assignment.surface.name === DELETE
        ? ["ui:owned-connection-record-picker", "ui:activation:owned-connection-delete-confirmation-opened"]
        : assignment.surface.name === CANCEL_DELETE
          ? ["ui:owned-connection-record-picker", "ui:activation:owned-connection-delete-cancelled"]
          : assignment.surface.name === CONFIRM_DELETE
            ? ["ui:owned-connection-record-picker", "ui:activation:owned-connection-record-deleted"]
        : assignment.surface.name === SETTINGS_REFRESH
          ? ["ui:owned-connection-record-settings", "ui:activation:owned-connection-directory-refreshed"]
          : assignment.surface.name === SETTINGS_EDIT
            ? ["ui:owned-connection-record-settings", "ui:activation:owned-connection-editor-opened"]
            : assignment.surface.name === SETTINGS_DELETE
              ? ["ui:owned-connection-record-settings", "ui:activation:owned-connection-delete-confirmation-opened"]
              : assignment.surface.name === SETTINGS_CANCEL_DELETE
                ? ["ui:owned-connection-record-settings", "ui:activation:owned-connection-delete-cancelled"]
                : assignment.surface.name === SETTINGS_CONFIRM_DELETE
                  ? ["ui:owned-connection-record-settings", "ui:activation:owned-connection-record-deleted"]
                  : null;
  if (!contract || assignment.fixtureId !== contract[0] || assignment.oracleId !== contract[1]
    || assignment.cleanupId !== CONNECTION_LIFECYCLE_CLEANUPS[0]) {
    throw new Error(`connection lifecycle assignment contract drifted for ${assignment.surface.name}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function connectionDirectory(connection: Connection): Promise<{ presets: Preset[] }> {
  return parseDirectory(await apiText(connection, "GET", "/connections"));
}

function parseDirectory(value: string): { presets: Preset[] } {
  const parsed = JSON.parse(value) as { presets?: unknown };
  if (!Array.isArray(parsed.presets)) throw new Error("connection directory did not return a preset array");
  for (const preset of parsed.presets) {
    if (!preset || typeof preset !== "object" || Array.isArray(preset)
      || typeof (preset as Preset).id !== "string" || typeof (preset as Preset).label !== "string") {
      throw new Error("connection directory returned an invalid preset");
    }
  }
  return { presets: parsed.presets as Preset[] };
}

async function apiText(connection: Connection, method: string, path: string, body?: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text}`);
  return text;
}

async function apiJson<T = Record<string, unknown>>(
  connection: Connection,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const text = await apiText(connection, method, path, body);
  return text ? JSON.parse(text) as T : {} as T;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-connection-lifecycle",
    ...body,
  });
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
    observedEffect: "No native connection lifecycle transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  outcome.cleanup = error ? "fail" : "pass";
  if (error) outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if (outcome.present !== "pass" || outcome.invoke !== "pass" || outcome.effect !== "pass" || outcome.cleanup !== "pass") {
    outcome.error ??= "connection lifecycle evidence was incomplete";
  }
  return outcome;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
