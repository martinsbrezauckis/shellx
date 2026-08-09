import {
  acceptReleaseSurfaceInstalledInputAlert,
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  createReleaseSurfaceInstalledInputSession,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type Json = Record<string, unknown>;
type SettingsTab = "general" | "vault" | "connections" | "connectors" | "desktop" | "shellxagent" | "data" | "about";
type Action = "refresh" | "save" | "simulate" | "test" | "delete";

const DRIVER_ID = "ui-control-connectors-production-lifecycle-installed";
const SOURCE = "src/components/settings/ConnectorsTab.tsx";
const OWNED_PREFIX = "release-owned-connectors-035";
const OWNED_VAULT_KEY = `${OWNED_PREFIX}/telegram-token`;
const OWNED_TOKEN = "SHELLX_RELEASE_CONNECTOR_TOKEN_INVALID_SHAPE_035";
const OWNED_SENDER = "release-owned-sender-035";
const OWNED_CONVERSATION = "release-owned-conversation-035";
const OWNED_MESSAGE = "SHELLX_RELEASE_CONNECTOR_INBOUND_035";
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const CONNECTORS_TAB = "[data-debug-id='settings-tab-connectors']";
const NEW = "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])";
const CANCEL = "[aria-label='Cancel connector draft']";
const VAULT_KEY = "[data-debug-id='surface-components-settings-connectorstab-21']";
const SECRET = "[id='connector-secret']";
const ALLOWED = "[id='connector-allowed']";
const SAVE = "[data-debug-id='surface-components-settings-connectorstab-12']";
const REFRESH = "[data-debug-id='surface-components-settings-connectorstab-1']";
const SIM_CONNECTOR = "[id='connector-sim-connector']";
const SIM_SENDER = "[id='connector-sim-sender']";
const SIM_CONVERSATION = "[id='connector-sim-conversation']";
const SIM_TEXT = "[id='connector-sim-text']";
const SIMULATE = "[data-debug-id='surface-components-settings-connectorstab-17']";
const CLEANUP_ID = "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile";
const ORACLE_ID = "ui:activation:owned-connector-production-transition";

const ACTIONS = new Map<string, Action>([
  [`${SOURCE}:[data-debug-id="surface-components-settings-connectorstab-1"]`, "refresh"],
  [`${SOURCE}:[data-debug-id="surface-components-settings-connectorstab-12"]`, "save"],
  [`${SOURCE}:[data-debug-id="surface-components-settings-connectorstab-17"]`, "simulate"],
  [`${SOURCE}:[data-debug-id="surface-components-settings-connectorstab-18"]`, "test"],
  [`${SOURCE}:role=button;name="Delete"`, "delete"],
]);

export const CONNECTORS_PRODUCTION_SURFACE_NAMES = new Set(ACTIONS.keys());
export const CONNECTORS_PRODUCTION_FIXTURES = [...ACTIONS.values()].map((action) => `ui:connectors-production-owned-${action}`);

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: DRIVER_ID,
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/ui-control-connectors-production-lifecycle-installed.ts",
    "src/components/settings/ConnectorsTab.tsx",
    "src-tauri/src/outside_connectors.rs",
  ],
  supportedFixtures: CONNECTORS_PRODUCTION_FIXTURES,
  supportedCleanups: [CLEANUP_ID],
  supportedOracles: [ORACLE_ID],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  releaseSurfaceProfileLaunchRootFromDebugTokenPath(request.runtime.debugTokenPath, request.platform);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseConnectorsProductionLifecycle(connection, input, request, assignment));
  }
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

export async function exerciseConnectorsProductionLifecycle(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTIONS.get(assignment.surface.name);
  const outcome = emptyOutcome(assignment);
  if (!action || assignment.fixtureId !== `ui:connectors-production-owned-${action}`
    || assignment.oracleId !== ORACLE_ID || assignment.cleanupId !== CLEANUP_ID) {
    outcome.error = `Connectors production driver rejected ${assignment.surface.name}`;
    return outcome;
  }
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  let baseline: { settingsOpen: boolean; settingsTab: SettingsTab } | null = null;
  let connectorId: string | null = null;
  try {
    releaseSurfaceProfileLaunchRootFromDebugTokenPath(request.runtime.debugTokenPath, request.platform);
    baseline = await readSettingsBaseline(connection);
    await requireOwnedBaseline(connection, relay);
    await resetVault(connection, "initial reset");
    await seedVault(connection);
    if (action === "refresh") connectorId = await exerciseRefresh(connection, input, relay, outcome);
    else if (action === "save") connectorId = await exerciseSave(connection, input, relay, outcome);
    else if (action === "simulate") connectorId = await exerciseSimulate(connection, input, relay, outcome);
    else if (action === "test") connectorId = await exerciseTest(connection, input, relay, outcome);
    else connectorId = await exerciseDelete(connection, input, relay, outcome);
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupError = await cleanup(connection, input, relay, baseline, connectorId);
    if (!cleanupError) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, `cleanup: ${cleanupError}`);
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Connectors production lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function exerciseRefresh(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  await openConnectors(connection, input);
  const id = ownedId("refresh");
  await saveOwnedConnector(relay, id, await activeTabId(connection));
  const control = await waitForReleaseSurfaceInstalledInputElement(input, REFRESH);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, row(id));
  const stored = await findConnector(relay, id);
  if (!stored || record(stored.provider, "stored connector provider").kind !== "telegram"
    || record(stored.target, "stored connector target").mode !== "fixedTab") {
    throw new Error("Refresh did not render the exact persisted fixed-session connector");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Refresh click reloaded one exact release-owned connector from the isolated production store and rendered its fixed local-session row without reading operator configuration.";
  return id;
}

async function exerciseSave(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  await openConnectors(connection, input);
  const create = await waitForReleaseSurfaceInstalledInputElement(input, NEW);
  await clickReleaseSurfaceInstalledInputElement(input, create);
  await waitForReleaseSurfaceInstalledInputElement(input, CANCEL);
  await replaceInput(input, VAULT_KEY, OWNED_VAULT_KEY);
  await replaceInput(input, SECRET, OWNED_TOKEN);
  await replaceInput(input, ALLOWED, OWNED_SENDER);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, SAVE);
  const before = await observeReleaseSurfaceInstalledInputElement(input, SAVE, ["disabled"]);
  if (before.disabled === true) throw new Error("owned Connector Save remained disabled after exact native input");
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, CANCEL);
  const stored = await waitForConnectorByVaultKey(relay, OWNED_VAULT_KEY);
  const id = requiredString(stored.id, "saved connector id");
  await waitForReleaseSurfaceInstalledInputElement(input, row(id));
  if (stored.enabled !== false || stored.dispatchMode !== "inbox"
    || record(stored.provider, "saved connector provider").kind !== "telegram") {
    throw new Error("Save persisted an unsafe connector mode or the wrong provider");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "Native connector input plus Save persisted one disabled Inbox connector and its write-only synthetic Vault credential in the isolated candidate; verification used only connector metadata and never returned the token.";
  return id;
}

async function exerciseSimulate(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  const id = ownedId("simulate");
  await saveOwnedConnector(relay, id, await activeTabId(connection));
  await openConnectors(connection, input);
  await waitForReleaseSurfaceInstalledInputElement(input, row(id));
  await selectConnector(input, id);
  await replaceInput(input, SIM_SENDER, OWNED_SENDER);
  await replaceInput(input, SIM_CONVERSATION, OWNED_CONVERSATION);
  await replaceInput(input, SIM_TEXT, OWNED_MESSAGE);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, SIMULATE);
  const before = await observeReleaseSurfaceInstalledInputElement(input, SIMULATE, ["disabled"]);
  if (before.disabled === true) throw new Error("owned Simulate inbound remained disabled after exact native input");
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForInputValue(input, SIM_TEXT, "");
  const events = await connectorEvents(relay);
  const event = events.find((candidate) => candidate.connectorId === id);
  if (!event || event.status !== "rejected" || event.reason !== "connector is disabled"
    || event.target !== `fixed:${await activeTabId(connection)}`) {
    throw new Error("Simulate inbound did not persist the exact non-dispatching production event");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "Native simulator input created one production inbound event for the disabled release-owned connector, persisted the expected rejected/no-dispatch status, and cleared the message draft without contacting a provider.";
  return id;
}

async function exerciseTest(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  const id = ownedId("test");
  await saveOwnedConnector(relay, id, await activeTabId(connection));
  await openConnectors(connection, input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, testButton(id));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, `${row(id)} .connector-error`);
  const stored = await waitForTestReceipt(relay, id);
  if (!Number.isSafeInteger(stored.lastTestMs)
    || stored.lastError !== "telegram bot token must have '<digits>:<token>' shape") {
    throw new Error("Test did not persist the expected pre-network Vault-token validation receipt");
  }
  outcome.effect = "pass";
  outcome.observedEffect = "A native Test click read the synthetic token through the production Vault path, rejected its deliberate pre-network shape, and persisted the exact bounded test timestamp/error without creating any network client or exposing the token.";
  return id;
}

async function exerciseDelete(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<string> {
  const id = ownedId("delete");
  const saved = await saveOwnedConnector(relay, id, await activeTabId(connection));
  await openConnectors(connection, input);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, deleteButton(id));
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  await acceptReleaseSurfaceInstalledInputAlert(input, `Delete connector "${requiredString(saved.label, "connector label")}"?`);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, row(id));
  if (await findConnector(relay, id)) throw new Error("Delete left the release-owned connector in the production store");
  outcome.effect = "pass";
  outcome.observedEffect = "A native Delete click plus its exact confirmation removed only the release-owned persisted connector and refreshed the isolated list; Vault cleanup remained separately bounded.";
  return id;
}

async function requireOwnedBaseline(connection: Connection, relay: ReleaseSurfaceTauriInvokeSession): Promise<void> {
  const rows = await connectorList(relay);
  const foreign = rows.filter((connector) => !requiredString(connector.id, "connector id").startsWith(OWNED_PREFIX));
  if (foreign.length > 0) throw new Error("isolated connector profile contained non-owned connector state");
  for (const connector of rows) await relay.invoke("outside_connectors_delete", { id: connector.id });
  if ((await connectorList(relay)).length !== 0) throw new Error("owned connector baseline did not clear exactly");
  const state = await apiJson(connection, "GET", "/state/ui");
  const tab = record(state.activeTab, "active tab");
  if (tab.connectionTransport !== "local" || !requiredString(tab.tabId, "active tab id")) {
    throw new Error("Connectors production lifecycle requires one candidate-local fixed session identity");
  }
}

async function seedVault(connection: Connection): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/set", {
    key: OWNED_VAULT_KEY,
    value: OWNED_TOKEN,
    description: "Synthetic disabled connector credential for final surface testing",
    userOnly: true,
  });
  if (response.ok !== true || response.key !== OWNED_VAULT_KEY || JSON.stringify(response).includes(OWNED_TOKEN)) {
    throw new Error("isolated connector Vault seed did not return its exact redacted acknowledgement");
  }
}

async function resetVault(connection: Connection, label: string): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/e2e/reset", {});
  if (response.ok !== true || JSON.stringify(response).includes(OWNED_TOKEN)) {
    throw new Error(`isolated connector Vault ${label} failed closed`);
  }
}

async function openConnectors(connection: Connection, input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  await postUi(connection, { openModal: "settings", source: "final-surface-connectors-production-open" });
  await openConnectorsFromCurrent(input);
}

async function openConnectorsFromCurrent(input: ReleaseSurfaceInstalledInputSession): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DIALOG);
  const tab = await waitForReleaseSurfaceInstalledInputElement(input, CONNECTORS_TAB);
  await clickReleaseSurfaceInstalledInputElement(input, tab);
  await waitForReleaseSurfaceInstalledInputElement(input, `${CONNECTORS_TAB}[aria-selected='true']`);
}

async function saveOwnedConnector(relay: ReleaseSurfaceTauriInvokeSession, id: string, tabId: string): Promise<Json> {
  const now = 1_750_000_000_000;
  const value = await relay.invoke("outside_connectors_save", {
    connector: {
      id,
      label: `Release owned ${id.slice(OWNED_PREFIX.length + 1)}`,
      enabled: false,
      provider: { kind: "telegram", botTokenVaultKey: OWNED_VAULT_KEY, allowedChatIds: [OWNED_SENDER] },
      target: { mode: "fixedTab", tabId },
      dispatchMode: "inbox",
      requireApproval: true,
      createdMs: now,
      updatedMs: now,
      lastTestMs: null,
      lastError: null,
    },
  });
  const saved = record(value, "saved connector");
  if (saved.id !== id || saved.enabled !== false) throw new Error("production connector seed returned the wrong identity or mode");
  return saved;
}

async function selectConnector(input: ReleaseSurfaceInstalledInputSession, id: string): Promise<void> {
  const selector = await waitForReleaseSurfaceInstalledInputElement(input, SIM_CONNECTOR);
  const storedLabel = `Release owned ${id.slice(OWNED_PREFIX.length + 1)} · Telegram`;
  await setReleaseSurfaceInstalledInputElementValue(input, selector, storedLabel);
  await waitForInputValue(input, SIM_CONNECTOR, id);
}

async function replaceInput(input: ReleaseSurfaceInstalledInputSession, selector: string, value: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector);
  await clearReleaseSurfaceInstalledInputElement(input, element);
  await setReleaseSurfaceInstalledInputElementValue(input, element, value);
  if (selector !== SECRET) await waitForInputValue(input, selector, value);
}

async function waitForInputValue(input: ReleaseSurfaceInstalledInputSession, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(input, selector, ["value"]);
    if (value.value === expected) return;
    await delay(50);
  }
  throw new Error(`Connectors input did not reach its exact bounded state for ${selector}`);
}

async function waitForConnectorByVaultKey(relay: ReleaseSurfaceTauriInvokeSession, vaultKey: string): Promise<Json> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (await connectorList(relay)).find((connector) => (
      record(connector.provider, "connector provider").botTokenVaultKey === vaultKey
    ));
    if (row) return row;
    await delay(50);
  }
  throw new Error("saved connector did not appear in the production store");
}

async function waitForTestReceipt(relay: ReleaseSurfaceTauriInvokeSession, id: string): Promise<Json> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = await findConnector(relay, id);
    if (row && Number.isSafeInteger(row.lastTestMs) && typeof row.lastError === "string") return row;
    await delay(50);
  }
  throw new Error("connector Test did not persist a bounded receipt");
}

async function connectorList(relay: ReleaseSurfaceTauriInvokeSession): Promise<Json[]> {
  const value = await relay.invoke("outside_connectors_list", {});
  if (!Array.isArray(value)) throw new Error("outside_connectors_list returned a non-array");
  return value.map((row) => record(row, "connector row"));
}

async function connectorEvents(relay: ReleaseSurfaceTauriInvokeSession): Promise<Json[]> {
  const value = await relay.invoke("outside_connectors_events", { limit: 50 });
  if (!Array.isArray(value)) throw new Error("outside_connectors_events returned a non-array");
  return value.map((row) => record(row, "connector event"));
}

async function findConnector(relay: ReleaseSurfaceTauriInvokeSession, id: string): Promise<Json | null> {
  return (await connectorList(relay)).find((connector) => connector.id === id) ?? null;
}

async function activeTabId(connection: Connection): Promise<string> {
  const state = await apiJson(connection, "GET", "/state/ui");
  return requiredString(record(state.activeTab, "active tab").tabId, "active tab id");
}

async function readSettingsBaseline(connection: Connection): Promise<{ settingsOpen: boolean; settingsTab: SettingsTab }> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const tab = String(state.settingsTab ?? "");
  if (!["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"].includes(tab)) {
    throw new Error("public UI state did not expose a supported Settings baseline tab");
  }
  return { settingsOpen: state.settingsOpen === true, settingsTab: tab as SettingsTab };
}

async function cleanup(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  relay: ReleaseSurfaceTauriInvokeSession,
  baseline: { settingsOpen: boolean; settingsTab: SettingsTab } | null,
  connectorId: string | null,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const cancel = await findReleaseSurfaceInstalledInputElement(input, CANCEL);
    if (cancel) await clickReleaseSurfaceInstalledInputElement(input, cancel);
  } catch (error) { errors.push(`draft: ${errorText(error)}`); }
  try {
    const rows = await connectorList(relay);
    for (const connector of rows) {
      const id = requiredString(connector.id, "cleanup connector id");
      const provider = record(connector.provider, "cleanup connector provider");
      if (!id.startsWith(OWNED_PREFIX) && provider.botTokenVaultKey !== OWNED_VAULT_KEY) {
        throw new Error("cleanup encountered a non-owned connector");
      }
      await relay.invoke("outside_connectors_delete", { id });
    }
    if ((await connectorList(relay)).some((connector) => String(connector.id).startsWith(OWNED_PREFIX))) {
      throw new Error("owned connector remained after cleanup");
    }
    if (connectorId && !connectorId.startsWith(OWNED_PREFIX)) {
      const stillPresent = await findConnector(relay, connectorId);
      if (stillPresent) throw new Error("generated owned connector remained after cleanup");
    }
  } catch (error) { errors.push(`connectors: ${errorText(error)}`); }
  try {
    await resetVault(connection, "cleanup reset");
    const resources = await apiJson(connection, "GET", `/vault/resources?prefix=${encodeURIComponent(OWNED_PREFIX)}`);
    if (!Array.isArray(resources.resources) || resources.resources.length !== 0 || resources.secretExposed !== false) {
      throw new Error("owned connector Vault resource remained after cleanup");
    }
  } catch (error) { errors.push(`Vault: ${errorText(error)}`); }
  try { await relay.cleanup(); } catch (error) { errors.push(`relay: ${errorText(error)}`); }
  try {
    await postUi(connection, { openModal: "close", source: "final-surface-connectors-production-cleanup" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DIALOG);
    if (baseline?.settingsOpen) {
      await postUi(connection, { openModal: "settings", source: "final-surface-connectors-production-restore" });
      await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DIALOG);
      const selector = `[data-debug-id='settings-tab-${baseline.settingsTab}']`;
      const tab = await waitForReleaseSurfaceInstalledInputElement(input, selector);
      await clickReleaseSurfaceInstalledInputElement(input, tab);
      await waitForReleaseSurfaceInstalledInputElement(input, `${selector}[aria-selected='true']`);
    }
  } catch (error) { errors.push(`view: ${errorText(error)}`); }
  return errors.length > 0 ? errors.join("; ") : null;
}

function row(id: string): string { return `[data-connector-id='${id}']`; }
function testButton(id: string): string { return `${row(id)} [data-debug-id='surface-components-settings-connectorstab-18']`; }
function deleteButton(id: string): string { return `${row(id)} .settings-pill-danger`; }
function ownedId(action: Action): string { return `${OWNED_PREFIX}-${action}`; }

async function apiJson(connection: Connection, method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  let value: unknown;
  try { value = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error(`${method} ${path} returned non-JSON status ${response.status}`); }
  if (!response.ok) throw new Error(`${method} ${path} failed with status ${response.status}`);
  return record(value, `${method} ${path}`);
}

function record(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Json;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} was missing`);
  return value;
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
    observedEffect: "No release-owned production connector transition was observed.",
  };
}

function appendError(current: string | undefined, next: string): string { return current ? `${current}; ${next}` : next; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

runReleaseSurfaceDriverCli(manifest, execute);
