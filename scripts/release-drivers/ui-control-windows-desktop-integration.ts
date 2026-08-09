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
import { observeWindowsDesktopIntegration } from "./windows-desktop-integration-lifecycle";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const REFRESH = 'src/components/settings/DesktopTab.tsx:[data-debug-id="surface-components-settings-desktoptab-1"]';
const INSTALL = 'src/components/settings/DesktopTab.tsx:role=button;name="Install"';
const REMOVE = 'src/components/settings/DesktopTab.tsx:role=button;name="Remove"';
const SUPPORTED = new Set([REFRESH, INSTALL, REMOVE]);
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const GENERAL_TAB = "[data-debug-id='settings-tab-general']";
const DESKTOP_TAB = "[data-debug-id='settings-tab-desktop']";
const REFRESH_CONTROL = "[data-desktop-integration-action='refresh']";
const INSTALL_CONTROL = "[data-desktop-integration-action='install']";
const REMOVE_CONTROL = "[data-desktop-integration-action='remove']";
const STATUS_RECEIPT = "[data-desktop-integration-status]";

export const WINDOWS_DESKTOP_INTEGRATION_UI_FIXTURES = [
  "ui:windows-desktop-integration-empty-baseline",
] as const;
export const WINDOWS_DESKTOP_INTEGRATION_UI_CLEANUPS = [
  "ui:remove-owned-windows-desktop-integration-restore-settings",
] as const;
export const WINDOWS_DESKTOP_INTEGRATION_UI_ORACLES = [
  "ui:activation:windows-desktop-integration-refresh-receipt",
  "ui:activation:windows-desktop-integration-installed",
  "ui:activation:windows-desktop-integration-removed",
] as const;

export function supportsWindowsDesktopIntegrationControl(assignment: Assignment): boolean {
  return SUPPORTED.has(assignment.surface.name);
}

export async function exerciseWindowsDesktopIntegrationControl(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let ownsIntegration = false;
  let openedSettings = false;
  try {
    assertAssignmentContract(request, assignment);
    if (request.platform === "windows-installed") {
      observeWindowsDesktopIntegration(request, "preflight-absent");
    }
    await openDesktopSettings(connection, input);
    openedSettings = true;
    await waitForAbsentReadyState(input, request.platform);

    if (assignment.surface.name === REFRESH) {
      await exerciseRefresh(input, request, outcome);
    } else if (assignment.surface.name === INSTALL) {
      ownsIntegration = true;
      await exerciseInstall(input, request, outcome);
    } else if (assignment.surface.name === REMOVE) {
      ownsIntegration = true;
      await installThroughUi(input, request);
      await exerciseRemove(input, request, outcome);
    } else {
      throw new Error(`unsupported Windows desktop integration control ${assignment.surface.name}`);
    }
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (ownsIntegration) {
      try {
        const removed = await invokeTemporaryTauriCommand(
          connection,
          "desktop_integration_remove_windows_context_menu",
        );
        verifyStatus(removed, false, "desktop integration cleanup");
        observeWindowsDesktopIntegration(request, "absent");
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (openedSettings) {
      try {
        const general = await waitForReleaseSurfaceInstalledInputElement(input, GENERAL_TAB, { timeoutMs: 2_000 });
        await clickReleaseSurfaceInstalledInputElement(input, general);
        await waitForReleaseSurfaceInstalledInputElement(input, `${GENERAL_TAB}[aria-selected='true']`, { timeoutMs: 2_000 });
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", source: "final-surface-windows-desktop-integration-cleanup" });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DIALOG, { timeoutMs: 2_000 });
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, `cleanup: ${cleanupErrors.join("; ")}`);
  }
  return finalize(outcome);
}

async function exerciseRefresh(
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const baseline = await readRefreshReceipt(input);
  if (baseline.sequence !== 0 || baseline.completedAtMs !== 0 || baseline.disabled) {
    throw new Error("Desktop Settings Refresh did not begin at its exact empty manual-receipt baseline");
  }
  const control = await waitForReleaseSurfaceInstalledInputElement(input, REFRESH_CONTROL);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  const receipt = await waitForRefreshReceipt(input, 1);
  const status = await readDesktopIntegrationStatus(input);
  if (request.platform === "windows-installed") {
    observeWindowsDesktopIntegration(request, "absent");
  }
  outcome.effect = "pass";
  outcome.observedEffect = `A native click completed manual Desktop integration refresh sequence ${receipt.sequence} with a bounded ${status.os} status receipt while the platform integration baseline remained absent.`;
}

async function exerciseInstall(
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(input, INSTALL_CONTROL);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, REMOVE_CONTROL);
  observeWindowsDesktopIntegration(request, "installed");
  outcome.effect = "pass";
  outcome.observedEffect = "A native click installed both exact candidate-owned HKCU Explorer verbs and the exact SendTo shortcut, and Desktop Settings changed to its Remove state.";
}

async function installThroughUi(
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(input, INSTALL_CONTROL);
  await clickReleaseSurfaceInstalledInputElement(input, control);
  await waitForReleaseSurfaceInstalledInputElement(input, REMOVE_CONTROL);
  observeWindowsDesktopIntegration(request, "installed");
}

async function exerciseRemove(
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(input, REMOVE_CONTROL);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(input, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(input, INSTALL_CONTROL);
  observeWindowsDesktopIntegration(request, "absent");
  outcome.effect = "pass";
  outcome.observedEffect = "A native click removed both prepared candidate-owned HKCU Explorer verbs and the SendTo shortcut, and Desktop Settings returned to its Install state.";
}

async function openDesktopSettings(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  await postUi(connection, { openModal: "settings", source: "final-surface-windows-desktop-integration" });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DIALOG);
  await waitForReleaseSurfaceInstalledInputElement(input, `${GENERAL_TAB}[aria-selected='true']`);
  const desktop = await waitForReleaseSurfaceInstalledInputElement(input, DESKTOP_TAB);
  await clickReleaseSurfaceInstalledInputElement(input, desktop);
  await waitForReleaseSurfaceInstalledInputElement(input, `${DESKTOP_TAB}[aria-selected='true']`);
  await waitForReleaseSurfaceInstalledInputElement(
    input,
    "#settings-tab-panel[aria-labelledby='settings-tab-desktop']",
  );
}

async function waitForAbsentReadyState(
  input: ReleaseSurfaceInstalledInputSession,
  platform: ReleaseSurfaceDriverRequest["platform"],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await waitForReleaseSurfaceInstalledInputElement(input, INSTALL_CONTROL, { timeoutMs: 250, pollMs: 25 });
      const refresh = await readRefreshReceipt(input);
      const status = await readDesktopIntegrationStatus(input);
      const expectedOs = platform === "windows-installed" ? "windows"
        : platform === "macos-installed" ? "macos" : "linux";
      const expectedSupported = platform === "windows-installed";
      if (!refresh.disabled && status.os === expectedOs && status.supported === expectedSupported && !status.installed) return;
    } catch {
      // The mount-time status request and React render may settle on adjacent turns.
    }
    await delay(50);
  }
  throw new Error("Desktop Settings did not settle at its expected platform integration baseline");
}

async function readDesktopIntegrationStatus(
  input: ReleaseSurfaceInstalledInputSession,
): Promise<{ supported: boolean; os: string; installed: boolean }> {
  const observed = await observeReleaseSurfaceInstalledInputElement(input, STATUS_RECEIPT, ["title"]);
  const match = observed.title?.match(/^Desktop integration state: supported=(yes|no); os=([a-z0-9_-]+); installed=(yes|no)$/);
  if (!observed.present || !observed.visible || !match) {
    throw new Error("Desktop Settings omitted its bounded platform status receipt");
  }
  return {
    supported: match[1] === "yes",
    os: match[2]!,
    installed: match[3] === "yes",
  };
}

async function readRefreshReceipt(
  input: ReleaseSurfaceInstalledInputSession,
): Promise<{ sequence: number; completedAtMs: number; disabled: boolean }> {
  const observed = await observeReleaseSurfaceInstalledInputElement(
    input,
    REFRESH_CONTROL,
    ["title", "disabled"],
  );
  const match = observed.title?.match(/^Refresh desktop integration status; sequence=(\d+); completedAtMs=(\d+)$/);
  if (!observed.present || !observed.visible || typeof observed.disabled !== "boolean" || !match) {
    throw new Error("Desktop Settings Refresh omitted its bounded manual receipt");
  }
  const sequence = Number(match[1]);
  const completedAtMs = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(completedAtMs)) {
    throw new Error("Desktop Settings Refresh returned an invalid bounded manual receipt");
  }
  return { sequence, completedAtMs, disabled: observed.disabled };
}

async function waitForRefreshReceipt(
  input: ReleaseSurfaceInstalledInputSession,
  sequence: number,
): Promise<{ sequence: number; completedAtMs: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const receipt = await readRefreshReceipt(input);
    if (receipt.sequence === sequence && receipt.completedAtMs > 0 && !receipt.disabled) return receipt;
    await delay(50);
  }
  throw new Error("Desktop Settings Refresh did not publish one exact successful manual receipt");
}

function assertAssignmentContract(request: ReleaseSurfaceDriverRequest, assignment: Assignment): void {
  if (assignment.surface.name !== REFRESH && request.platform !== "windows-installed") {
    throw new Error("Desktop integration install and remove controls are Windows-only surfaces");
  }
  if (request.platform === "windows-installed" && inputTransport(request) !== "windows-native-webdriver") {
    throw new Error("Windows desktop integration UI proof requires the native Windows final-candidate input binding");
  }
  const oracle = assignment.surface.name === REFRESH
    ? "ui:activation:windows-desktop-integration-refresh-receipt"
    : assignment.surface.name === INSTALL
      ? "ui:activation:windows-desktop-integration-installed"
      : "ui:activation:windows-desktop-integration-removed";
  if (assignment.fixtureId !== "ui:windows-desktop-integration-empty-baseline"
    || assignment.oracleId !== oracle
    || assignment.cleanupId !== "ui:remove-owned-windows-desktop-integration-restore-settings") {
    throw new Error("Windows desktop integration UI assignment contract drifted");
  }
}

function inputTransport(request: ReleaseSurfaceDriverRequest): "windows-native-webdriver" | "invalid" {
  return request.nativeWebDriver && request.runtime.windowsNative ? "windows-native-webdriver" : "invalid";
}

async function invokeTemporaryTauriCommand(connection: Connection, command: string): Promise<unknown> {
  const started = requiredRecord(await apiJson(connection, "POST", "/release-test/tauri-invokes", {
    command,
    args: {},
  }), "desktop integration cleanup start");
  const invokeId = String(started.id ?? "");
  if (!/^rti-[0-9a-f]{32}$/.test(invokeId) || started.status !== "pending") {
    throw new Error("desktop integration cleanup relay returned an invalid start receipt");
  }
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = requiredRecord(
        await apiJson(connection, "GET", `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`),
        "desktop integration cleanup state",
      );
      if (state.status === "passed") return state.value;
      if (state.status === "failed") throw new Error("desktop integration cleanup command failed");
      if (state.status !== "pending") throw new Error("desktop integration cleanup returned an invalid state");
      await delay(100);
    }
    throw new Error("desktop integration cleanup command timed out");
  } finally {
    const removed = requiredRecord(
      await apiJson(connection, "DELETE", `/release-test/tauri-invokes/${encodeURIComponent(invokeId)}`),
      "desktop integration cleanup relay deletion",
    );
    if (removed.removed !== true) throw new Error("desktop integration cleanup relay state was not deleted");
  }
}

function verifyStatus(value: unknown, installed: boolean, label: string): void {
  const status = requiredRecord(value, label);
  if (status.supported !== true || status.os !== "windows"
    || status.explorerContextMenuInstalled !== installed
    || status.sendToShortcutInstalled !== installed
    || typeof status.message !== "string" || !status.message) {
    throw new Error(`${label} returned an invalid exact Windows state`);
  }
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", { debugSurface: "app", ...body });
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}`);
  return response.json();
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
    observedEffect: "No native Windows desktop integration lifecycle effect was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Windows desktop integration control did not satisfy every required verdict";
  }
  return outcome;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
