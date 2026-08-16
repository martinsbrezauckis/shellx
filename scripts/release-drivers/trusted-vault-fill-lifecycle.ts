import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ShellxDebugApiConnection } from "../shellx-debug-paths";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import {
  clickReleaseSurfaceInstalledInputElement,
  createReleaseSurfaceInstalledInputSession,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  releaseSurfaceControllerNodeArguments,
  resolveBoundReleaseSurfaceControllerFile,
} from "../lib/release-surface-controller-binding";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Json = Record<string, unknown>;
type Method = "GET" | "POST" | "DELETE";
type Action =
  | "release-fixture-route"
  | "browser-cli-secret"
  | "host-mcp-secret"
  | "host-mcp-profile"
  | "tauri-user-secret"
  | "ui-menu-control"
  | "ui-suggestion-control"
  | "ui-menu-marker"
  | "ui-badge-marker"
  | "ui-panel-marker"
  | "ui-suggestion-marker";

const TRUSTED_ORIGIN = "https://example.com";
const TRUSTED_URL = `${TRUSTED_ORIGIN}/`;
const SECRET_VALUE = "SHELLX_RELEASE_TRUSTED_VAULT_FILL_SECRET_035";
const PROFILE_VALUE = "shellx-release-profile@example.test";
const PASSWORD_SELECTOR = "#shellx-release-vault-password";
const PROFILE_SELECTOR = "#shellx-release-profile-email";
const SECRET_HASH = sha256(SECRET_VALUE);
const PROFILE_HASH = sha256(PROFILE_VALUE);
const FILL_MENU = "[data-debug-id='shellx-browser-vault-fill-menu']";
const FILL_BADGE = "[data-debug-id='shellx-browser-vault-fill-badge']";
const FILL_PANEL = "[data-debug-id='shellx-browser-vault-fill-panel']";
const FILL_SUGGESTION = "[data-debug-id='shellx-browser-vault-fill-suggestion']";
const DRIVER_TIMEOUT_MS = 30_000;

const UI_MENU_CONTROL = 'ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-vault-fill-menu"]@src/browser/components/BrowserChrome.tsx#18';
const UI_SUGGESTION_CONTROL = 'ui-control:src/browser/components/BrowserVaultFillPanel.tsx:[data-debug-id="shellx-browser-vault-fill-suggestion"]@src/browser/components/BrowserVaultFillPanel.tsx#1';

const ACTIONS = new Map<string, Action>([
  ["debug-api-route:POST /release-test/browser/trusted-vault-fixture", "release-fixture-route"],
  ["browser-cli-command:fill-from-vault", "browser-cli-secret"],
  ["host-mcp-tool:browser_fill_from_vault", "host-mcp-secret"],
  ["host-mcp-tool:browser_fill_profile_card", "host-mcp-profile"],
  ["tauri-command:shellx_browser_fill_user_vault_secret", "tauri-user-secret"],
  [UI_MENU_CONTROL, "ui-menu-control"],
  [UI_SUGGESTION_CONTROL, "ui-suggestion-control"],
  ["ui-debug-surface:shellx-browser-vault-fill-menu@src/browser/components/BrowserChrome.tsx#21", "ui-menu-marker"],
  ["ui-debug-surface:shellx-browser-vault-fill-badge@src/browser/components/BrowserChrome.tsx#22", "ui-badge-marker"],
  ["ui-debug-surface:shellx-browser-vault-fill-panel@src/browser/components/BrowserVaultFillPanel.tsx#1", "ui-panel-marker"],
  ["ui-debug-surface:shellx-browser-vault-fill-suggestion@src/browser/components/BrowserVaultFillPanel.tsx#3", "ui-suggestion-marker"],
]);

export const TRUSTED_VAULT_FILL_SURFACE_IDS = new Set(ACTIONS.keys());
export const TRUSTED_VAULT_FILL_FIXTURES = [
  "vault-fill:trusted-https-fixed-child-webview",
  "vault-fill:trusted-https-agent-secret",
  "vault-fill:trusted-https-profile-card",
  "vault-fill:trusted-https-user-suggestion",
] as const;
export const TRUSTED_VAULT_FILL_CLEANUPS = [
  "vault-fill:close-owned-route-task",
  "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
] as const;
export const TRUSTED_VAULT_FILL_ORACLES = [
  "vault-fill:release-fixture-route:redacted-form-and-proof",
  "vault-fill:browser-cli:trusted-field-hash",
  "vault-fill:host-mcp-secret:trusted-field-hash",
  "vault-fill:host-mcp-profile:trusted-field-hash",
  "vault-fill:tauri-user-secret:trusted-field-hash",
  "ui:disclosure-state-transition",
  "ui:activation:vault-fill-trusted-field-hash",
  "vault-fill:ui-markers:trusted-suggestion-state",
] as const;

export function supportsTrustedVaultFillSurface(assignment: Assignment): boolean {
  return ACTIONS.has(assignment.surface.id);
}

export function trustedVaultFillAction(surfaceId: string): Action | null {
  return ACTIONS.get(surfaceId) ?? null;
}

export async function exerciseTrustedVaultFillSurface(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  installedInput?: ReleaseSurfaceInstalledInputSession,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTIONS.get(assignment.surface.id);
  const outcome = emptyOutcome(assignment);
  if (!action) return fail(outcome, "unsupported trusted Vault fill surface");
  try {
    if (action === "release-fixture-route") {
      return await exerciseReleaseFixtureRoute(connection, assignment, request.runtime.instanceId);
    }
    if (action === "browser-cli-secret") return await exerciseBrowserCli(connection, request, assignment);
    if (action === "host-mcp-secret" || action === "host-mcp-profile") {
      return await exerciseHostMcp(connection, request, assignment, action);
    }
    if (action === "tauri-user-secret") return await exerciseTauri(connection, request, assignment);
    if (!installedInput) throw new Error("trusted Vault fill UI surface requires platform-native installed input");
    return await exerciseUi(connection, request, assignment, installedInput, action);
  } catch (error) {
    return fail(outcome, errorText(error));
  }
}

async function exerciseReleaseFixtureRoute(
  connection: ShellxDebugApiConnection,
  assignment: Assignment,
  instanceId: string,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const lifecycle = createLifecycleState("route", instanceId);
  try {
    const task = await apiJson(connection, "POST", "/browser/task/start", {
      goal: "Final surface fixed child-webview fixture route proof",
      startUrl: TRUSTED_URL,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      expectedDomains: ["example.com"],
    }, undefined, DRIVER_TIMEOUT_MS);
    lifecycle.taskId = requiredString(task.taskId, "trusted fixture route taskId");
    await settleTask(connection, lifecycle.taskId);
    const tab = await findBrowserTab(connection, lifecycle.taskId, null);
    lifecycle.browserTabId = requiredString(tab.browserTabId, "trusted fixture route browserTabId");
    verifyTrustedSecurity(tab);
    outcome.present = "pass";
    await injectTrustedFixture(connection, lifecycle);
    outcome.invoke = "pass";
    const proof = await readFieldProof(connection, lifecycle, "password");
    if (proof.fixture !== true || proof.present !== true || proof.hash !== "" || proof.events !== 0) {
      throw new Error("fixed child-webview fixture route returned a non-empty baseline proof");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "The isolated release route installed only the fixed form on the exact active example.com child webview and returned only an empty baseline SHA-256/event proof, never a value.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    finishCleanup(outcome, await cleanupLifecycle(connection, lifecycle));
  }
  return finalize(outcome);
}

export function createTrustedVaultFillInstalledInput(
  request: ReleaseSurfaceDriverRequest,
  connection: ShellxDebugApiConnection,
): ReleaseSurfaceInstalledInputSession {
  if (request.platform !== "macos-installed") {
    return createReleaseSurfaceInstalledInputSession(request, connection);
  }
  if (!request.macosNativeInput) {
    throw new Error("macOS trusted Vault fill requires the candidate-bound native-input helper");
  }
  return createReleaseSurfaceInstalledInputSession({ ...request, nativeWebDriver: undefined }, connection);
}

async function exerciseBrowserCli(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const lifecycle = createLifecycleState("cli", request.runtime.instanceId);
  try {
    await prepareAgentFixture(connection, lifecycle, "secret");
    const observed = await apiJson(connection, "POST", "/browser/action", {
      action: "observe",
      taskId: lifecycle.taskId,
      maxPayloadBytes: 4_000,
    });
    const refId = observedRefId(observed, PASSWORD_SELECTOR);
    outcome.present = "pass";
    const result = runBrowserCli([
      "fill-from-vault", refId, required(lifecycle.grantId, "CLI grant"), lifecycle.secretRef,
      "--task", required(lifecycle.taskId, "CLI task"),
    ], connection, request);
    outcome.invoke = "pass";
    verifyAppliedFillResult(result, lifecycle.taskId, "Browser CLI fill-from-vault");
    await verifyFieldHash(connection, lifecycle, "password", SECRET_HASH);
    outcome.effect = "pass";
    outcome.observedEffect = "Browser CLI fill-from-vault used one approved isolated Fill grant on the production-trusted HTTPS origin; only the target field's SHA-256 and input-event count were observed.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    finishCleanup(outcome, await cleanupLifecycle(connection, lifecycle));
  }
  return finalize(outcome);
}

async function exerciseHostMcp(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  action: "host-mcp-secret" | "host-mcp-profile",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const lifecycle = createLifecycleState(action === "host-mcp-profile" ? "mcp-profile" : "mcp-secret", request.runtime.instanceId);
  let mcp: McpConnection | null = null;
  try {
    mcp = await acquireMcpConnection(connection, request);
    lifecycle.autonomy = mcp.autonomy;
    await prepareAgentFixture(connection, lifecycle, action === "host-mcp-profile" ? "profile" : "secret", mcp.tabId);
    const toolName = action === "host-mcp-profile" ? "browser_fill_profile_card" : "browser_fill_from_vault";
    await proveMcpToolPresent(mcp, toolName);
    outcome.present = "pass";
    const selector = action === "host-mcp-profile" ? PROFILE_SELECTOR : PASSWORD_SELECTOR;
    const observed = await callMcpTool(mcp, "browser_observe", {
      taskId: lifecycle.taskId,
      fullObservation: true,
    }, false);
    const refId = observedRefId(observed, selector);
    const args = action === "host-mcp-profile"
      ? {
          taskId: lifecycle.taskId,
          grantId: lifecycle.grantId,
          resourceRef: lifecycle.secretRef,
          key: "email",
          refId,
        }
      : {
          taskId: lifecycle.taskId,
          grantId: lifecycle.grantId,
          secretRef: lifecycle.secretRef,
          refId,
        };
    const result = await callMcpTool(mcp, toolName, args);
    outcome.invoke = "pass";
    verifyAppliedFillResult(result, lifecycle.taskId, `Host MCP ${toolName}`);
    await verifyFieldHash(
      connection,
      lifecycle,
      action === "host-mcp-profile" ? "profileEmail" : "password",
      action === "host-mcp-profile" ? PROFILE_HASH : SECRET_HASH,
    );
    outcome.effect = "pass";
    outcome.observedEffect = action === "host-mcp-profile"
      ? "Host MCP browser_fill_profile_card extracted only the approved synthetic profile field and filled the trusted HTTPS target; evidence retained only its SHA-256 and event count."
      : "Host MCP browser_fill_from_vault used the approved isolated Fill grant on the trusted HTTPS target; evidence retained only the target SHA-256 and event count.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors = await cleanupLifecycle(connection, lifecycle);
    if (mcp?.autonomy) {
      const restore = await restoreAutonomy(connection, mcp.autonomy);
      if (restore) errors.push(restore);
    }
    finishCleanup(outcome, errors);
  }
  return finalize(outcome);
}

async function exerciseTauri(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const lifecycle = createLifecycleState("tauri", request.runtime.instanceId);
  try {
    await prepareUserFixture(connection, lifecycle);
    outcome.present = "pass";
    const value = await invokeTauri(connection, lifecycle, "shellx_browser_fill_user_vault_secret", {
      request: {
        browserTabId: lifecycle.browserTabId,
        secretRef: lifecycle.secretRef,
        selector: PASSWORD_SELECTOR,
        expectedOrigin: TRUSTED_ORIGIN,
      },
    });
    outcome.invoke = "pass";
    verifyAppliedFillResult(record(value, "Tauri Vault fill result"), null, "Tauri Vault fill");
    await verifyFieldHash(connection, lifecycle, "password", SECRET_HASH);
    outcome.effect = "pass";
    outcome.observedEffect = "Tauri shellx_browser_fill_user_vault_secret filled one user-owned trusted HTTPS field from the isolated user-only Vault item; evidence retained only its SHA-256 and input-event count.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    finishCleanup(outcome, await cleanupLifecycle(connection, lifecycle));
  }
  return finalize(outcome);
}

async function exerciseUi(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  input: ReleaseSurfaceInstalledInputSession,
  action: "ui-menu-control" | "ui-suggestion-control" | "ui-menu-marker" | "ui-badge-marker" | "ui-panel-marker" | "ui-suggestion-marker",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const lifecycle = createLifecycleState("ui", request.runtime.instanceId);
  try {
    await prepareUserFixture(connection, lifecycle);
    await refreshBrowserUiObservation(connection, lifecycle);
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    lifecycle.originalInputWindow = switched.originalHandle;
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_MENU, { timeoutMs: DRIVER_TIMEOUT_MS });
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_BADGE, { timeoutMs: DRIVER_TIMEOUT_MS });
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_PANEL, { timeoutMs: DRIVER_TIMEOUT_MS });
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_SUGGESTION, { timeoutMs: DRIVER_TIMEOUT_MS });
    outcome.present = "pass";
    if (action === "ui-menu-control") {
      await clickInput(input, FILL_MENU);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, FILL_PANEL);
      await clickInput(input, FILL_MENU);
      await waitForReleaseSurfaceInstalledInputElement(input, FILL_SUGGESTION);
      outcome.observedEffect = "Native installed input closed and reopened the exact Vault fill disclosure while its synthetic trusted-origin suggestion remained available.";
    } else if (action === "ui-suggestion-control") {
      await clickInput(input, FILL_SUGGESTION);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, FILL_PANEL);
      await verifyFieldHash(connection, lifecycle, "password", SECRET_HASH);
      outcome.observedEffect = "A trusted native click activated the exact Vault suggestion and filled the production-trusted HTTPS field; only its SHA-256 and event count were observed.";
    } else {
      outcome.observedEffect = `The exact ${action.replace("ui-", "").replace("-marker", "")} marker resolved inside a non-empty trusted-HTTPS Vault suggestion state without reading or exposing a field value.`;
    }
    outcome.invoke = "pass";
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors = await cleanupLifecycle(connection, lifecycle);
    try {
      await switchReleaseSurfaceInstalledInputWindow(input, lifecycle.originalInputWindow ?? "macos-native:app");
    } catch (error) {
      errors.push(`input window restore: ${errorText(error)}`);
    }
    finishCleanup(outcome, errors);
  }
  return finalize(outcome);
}

type LifecycleState = {
  namespace: string;
  secretRef: string;
  taskId: string | null;
  browserTabId: string | null;
  grantId: string | null;
  baselineBrowserTabId: string | null;
  originalInputWindow: "macos-native:app" | "macos-native:browser" | string | null;
  relayIds: string[];
  autonomy: AutonomyLease | null;
  vaultTouched: boolean;
};

function createLifecycleState(label: string, instanceId: string): LifecycleState {
  const namespace = `shellx-release-${instanceId}-${label}-trusted-fill`;
  return {
    namespace,
    secretRef: `${namespace}-resource`,
    taskId: null,
    browserTabId: null,
    grantId: null,
    baselineBrowserTabId: null,
    originalInputWindow: null,
    relayIds: [],
    autonomy: null,
    vaultTouched: false,
  };
}

async function prepareAgentFixture(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
  kind: "secret" | "profile",
  callerTabId?: string,
): Promise<void> {
  await resetVault(connection, "initial reset");
  state.vaultTouched = true;
  const raw = kind === "profile" ? JSON.stringify({ email: PROFILE_VALUE }) : SECRET_VALUE;
  const metadata = kind === "profile"
    ? { resourceKind: "profileCard", resourceSummary: `Profile for ${TRUSTED_ORIGIN}`, resourceFields: ["email"] }
    : { resourceKind: "secret", resourceSummary: `Password for ${TRUSTED_ORIGIN}`, resourceFields: ["password"] };
  await seedVault(connection, state.secretRef, raw, false, metadata);
  state.grantId = await approveGrant(connection, state.secretRef, kind === "profile" ? "profileFill" : "fill", raw);
  const task = await apiJson(connection, "POST", "/browser/task/start", {
    goal: "Final surface trusted HTTPS Vault fill proof",
    startUrl: TRUSTED_URL,
    profileId: "task-disposable",
    autonomy: "assistedAutonomous",
    expectedDomains: ["example.com"],
  }, callerTabId ? { "X-ShellX-MCP-Caller-ID": callerTabId } : undefined, DRIVER_TIMEOUT_MS);
  state.taskId = requiredString(task.taskId, "trusted Vault fill taskId");
  await settleTask(connection, state.taskId, callerTabId);
  const tab = await findBrowserTab(connection, state.taskId, null);
  state.browserTabId = requiredString(tab.browserTabId, "trusted Vault fill browserTabId");
  verifyTrustedSecurity(tab);
  await injectTrustedFixture(connection, state);
}

async function prepareUserFixture(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
): Promise<void> {
  await resetVault(connection, "initial reset");
  state.vaultTouched = true;
  await seedVault(connection, state.secretRef, SECRET_VALUE, true, {
    resourceKind: "secret",
    resourceSummary: `Password for ${TRUSTED_ORIGIN}`,
    resourceFields: ["password"],
  });
  const baseline = await apiJson(connection, "GET", "/browser/state");
  state.baselineBrowserTabId = optionalString(baseline.activeBrowserTabId);
  const opened = await apiJson(connection, "POST", "/browser/tabs/open", {
    profileId: "personal",
    url: TRUSTED_URL,
    expectedDomains: ["example.com"],
  });
  const tab = record(opened.tab, "trusted user Browser tab");
  state.browserTabId = requiredString(tab.browserTabId, "trusted user browserTabId");
  if (tab.ownerKind !== "user" || tab.profileId !== "personal") {
    throw new Error("trusted Vault fill user fixture did not stay personal and user-owned");
  }
  await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: state.browserTabId });
  await waitForBrowserTabLoaded(connection, state.browserTabId);
  verifyTrustedSecurity(await findBrowserTab(connection, null, state.browserTabId));
  await injectTrustedFixture(connection, state);
}

async function refreshBrowserUiObservation(connection: ShellxDebugApiConnection, state: LifecycleState): Promise<void> {
  if (state.baselineBrowserTabId && state.baselineBrowserTabId !== state.browserTabId) {
    await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: state.baselineBrowserTabId });
  }
  await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: state.browserTabId });
  await delay(800);
}

async function injectTrustedFixture(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
): Promise<void> {
  const result = await apiJson(connection, "POST", "/release-test/browser/trusted-vault-fixture", {
    action: "prepare",
    browserTabId: required(state.browserTabId, "trusted fixture browser tab"),
    taskId: state.taskId,
  });
  rejectRawValues(result, "trusted HTTPS fixture injection");
  if (result.ok !== true || result.action !== "prepare"
    || result.browserTabId !== state.browserTabId || result.taskId !== state.taskId
    || result.trusted !== true || result.origin !== TRUSTED_ORIGIN || result.inputs !== 2
    || result.secretExposed !== false) {
    throw new Error("candidate-bound fixture bridge did not preserve the exact trusted HTTPS origin and fixed form");
  }
}

async function verifyFieldHash(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
  field: "password" | "profileEmail",
  expectedHash: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const proof = await readFieldProof(connection, state, field);
    if (proof.fixture === true && proof.present === true && proof.hash === expectedHash
      && proof.events > 0) return;
    await delay(100);
  }
  throw new Error("trusted Vault fill did not produce the exact target hash and input event proof");
}

async function readFieldProof(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
  field: "password" | "profileEmail",
): Promise<{ fixture: boolean; present: boolean; hash: string; events: number }> {
  const proof = await apiJson(connection, "POST", "/release-test/browser/trusted-vault-fixture", {
    action: "proof",
    browserTabId: required(state.browserTabId, "trusted proof browser tab"),
    taskId: state.taskId,
    field,
  });
  rejectRawValues(proof, "trusted field proof");
  if (proof.ok !== true || proof.action !== "proof" || proof.field !== field
    || proof.browserTabId !== state.browserTabId || proof.taskId !== state.taskId
    || typeof proof.fixture !== "boolean" || typeof proof.present !== "boolean"
    || typeof proof.hash !== "string" || typeof proof.events !== "number"
    || !Number.isInteger(proof.events) || proof.events < 0 || proof.secretExposed !== false) {
    throw new Error("trusted field proof returned the wrong redacted fixture envelope");
  }
  return {
    fixture: proof.fixture,
    present: proof.present,
    hash: proof.hash,
    events: proof.events,
  };
}

async function cleanupLifecycle(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
): Promise<string[]> {
  const errors: string[] = [];
  for (const relayId of state.relayIds) {
    await cleanupAttempt(errors, async () => {
      const removed = await apiJson(connection, "DELETE", `/release-test/tauri-invokes/${encodeURIComponent(relayId)}`);
      if (removed.removed !== true) throw new Error("Tauri relay state remained after cleanup");
    });
  }
  if (state.taskId) {
    await cleanupAttempt(errors, async () => {
      const callerHeaders = state.autonomy?.tabId
        ? { "X-ShellX-MCP-Caller-ID": state.autonomy.tabId }
        : undefined;
      const cleanup = await cleanupOwnedBrowserLifecycle(
        (method, path, body) => apiJson(connection, method, path, body, callerHeaders),
        { taskIds: [state.taskId!], tabIds: state.browserTabId ? [state.browserTabId] : [], label: "trusted-vault-fill" },
      );
      if (cleanup.errors.length) throw new Error(cleanup.errors.join(" | "));
    });
  } else if (state.browserTabId) {
    await cleanupAttempt(errors, async () => {
      const closed = await apiJson(connection, "POST", "/browser/tabs/close", { browserTabId: state.browserTabId });
      if (closed.ok !== true) throw new Error("owned trusted user tab did not close");
    });
  }
  if (state.baselineBrowserTabId) {
    await cleanupAttempt(errors, async () => {
      await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: state.baselineBrowserTabId });
    });
  }
  if (state.vaultTouched) {
    await cleanupAttempt(errors, async () => {
      await resetVault(connection, "cleanup reset");
      const resources = await apiJson(connection, "GET", `/vault/resources?prefix=${encodeURIComponent(state.namespace)}`);
      const rows = Array.isArray(resources.resources) ? resources.resources : null;
      if (resources.secretExposed !== false || !rows || rows.length !== 0) {
        throw new Error("isolated Vault resources remained after trusted fill cleanup");
      }
      const grants = await apiJson(connection, "GET", "/vault/grants");
      if (!Array.isArray(grants.grants) || grants.grants.length !== 0) {
        throw new Error("isolated Vault grants remained after trusted fill cleanup");
      }
    });
  }
  return errors;
}

async function resetVault(connection: ShellxDebugApiConnection, label: string): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/e2e/reset", {});
  validateTrustedVaultResetResponse(response, label);
}

export function validateTrustedVaultResetResponse(response: Json, label: string): void {
  const receipt = record(response.receipt, `isolated Vault ${label} receipt`);
  if (response.ok !== true || receipt.action !== "vaultE2eReset" || receipt.secretExposed !== false) {
    throw new Error(`isolated Vault ${label} failed closed`);
  }
}

async function seedVault(
  connection: ShellxDebugApiConnection,
  key: string,
  value: string,
  userOnly: boolean,
  metadata: Json,
): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/set", {
    key,
    value,
    description: `Synthetic release credential for ${TRUSTED_ORIGIN}`,
    userOnly,
    ...metadata,
  });
  if (response.ok !== true || response.key !== key || JSON.stringify(response).includes(value)) {
    throw new Error("isolated Vault seed did not return its exact redacted acknowledgement");
  }
}

async function approveGrant(
  connection: ShellxDebugApiConnection,
  secretRef: string,
  operation: "fill" | "profileFill",
  forbiddenValue: string,
): Promise<string> {
  const response = await apiJson(
    connection,
    "POST",
    "/vault/e2e/approve-grant",
    trustedVaultGrantRequest(secretRef, operation, Date.now() + 10 * 60 * 1_000),
  );
  const grant = record(response.grant, "trusted Vault fill grant");
  const grantId = requiredString(grant.grantId, "trusted Vault fill grantId");
  const expectedOperation = operation === "fill" ? "Fill" : "ProfileFill";
  if (response.ok !== true || response.secretExposed !== false || grant.approved !== true
    || grant.secretRef !== secretRef || grant.operation !== expectedOperation
    || grant.origin !== TRUSTED_ORIGIN
    || JSON.stringify(response).includes(forbiddenValue)) {
    throw new Error("isolated Vault fill grant was not approved through the redacted E2E boundary");
  }
  return grantId;
}

export function trustedVaultGrantRequest(
  secretRef: string,
  operation: "fill" | "profileFill",
  expiresAtMs: number,
): Json {
  return {
    secretRef,
    actorScope: { kind: "allShellxAgents" },
    operation,
    origin: TRUSTED_ORIGIN,
    expiresAtMs,
  };
}

async function settleTask(connection: ShellxDebugApiConnection, taskId: string, callerTabId?: string): Promise<void> {
  const settled = await apiJson(
    connection,
    "GET",
    `/browser/settle?taskId=${encodeURIComponent(taskId)}&timeoutMs=${DRIVER_TIMEOUT_MS}`,
    undefined,
    callerTabId ? { "X-ShellX-MCP-Caller-ID": callerTabId } : undefined,
    DRIVER_TIMEOUT_MS + 5_000,
  );
  if (settled.settled !== true) throw new Error("trusted HTTPS Browser task did not settle");
}

async function waitForBrowserTabLoaded(connection: ShellxDebugApiConnection, browserTabId: string): Promise<void> {
  const deadline = Date.now() + DRIVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/browser/state");
    const engine = isRecord(state.engine) ? state.engine : null;
    if (state.activeBrowserTabId === browserTabId && engine?.loadStatus !== "navigating") return;
    await delay(100);
  }
  throw new Error("trusted user Browser tab did not finish loading");
}

async function findBrowserTab(
  connection: ShellxDebugApiConnection,
  taskId: string | null,
  browserTabId: string | null,
): Promise<Json> {
  const state = await apiJson(connection, "GET", "/browser/state");
  const tabs = Array.isArray(state.tabs) ? state.tabs.filter(isRecord) : [];
  const tab = tabs.find((candidate) => (
    taskId ? candidate.taskId === taskId : candidate.browserTabId === browserTabId
  ));
  if (!tab) throw new Error("trusted Vault fill Browser tab was absent from candidate state");
  return tab;
}

function verifyTrustedSecurity(tab: Json): void {
  const security = record(tab.securityState, "trusted Vault fill security state");
  if (security.level !== "secure" || security.credentialEntryAllowed !== true
    || optionalString(tab.url)?.startsWith(TRUSTED_ORIGIN) !== true) {
    throw new Error("trusted Vault fill fixture did not pass the production HTTPS credential-entry policy");
  }
}

function observedRefId(response: Json, selector: string): string {
  const observation = record(response.observation, "trusted Vault fill observation");
  const refs = Array.isArray(observation.refs) ? observation.refs.filter(isRecord) : [];
  const ref = refs.find((candidate) => candidate.selector === selector);
  return requiredString(ref?.refId, "trusted Vault fill observed refId");
}

function runBrowserCli(
  args: string[],
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
): Json {
  const browserCliPath = resolveBoundReleaseSurfaceControllerFile({
    rootDir: process.cwd(),
    binding: request.controller,
    relativePath: "scripts/shellx-browser-cli.ts",
  });
  const result = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(browserCliPath, args), {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: DRIVER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SHELLX_DEBUG_BASE: connection.base, SHELLX_DEBUG_TOKEN: connection.token },
  });
  if (result.status !== 0) throw new Error("Browser CLI trusted Vault fill invocation failed without retaining process output");
  const line = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  const parsed = line ? JSON.parse(line) as unknown : null;
  const body = record(parsed, "Browser CLI trusted Vault fill result");
  rejectRawValues(body, "Browser CLI trusted Vault fill result");
  return body;
}

type AutonomyLease = { tabId: string; previousMode: string };
type McpConnection = {
  base: string;
  token: string;
  mutationToken: string;
  tabId: string;
  autonomy: AutonomyLease;
};

async function acquireMcpConnection(
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
): Promise<McpConnection> {
  const path = nodeReadablePath(request.runtime.mcpTokenPath, request.platform);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Host MCP token must be a regular non-link file");
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("Host MCP token file is invalid");
  const ui = await apiJson(connection, "GET", "/state/ui");
  const activeTab = isRecord(ui.activeTab) ? ui.activeTab : null;
  const tabId = optionalString(activeTab?.tabId) ?? optionalString(ui.activeTabId);
  const previousMode = optionalString(activeTab?.autonomy) ?? optionalString(ui.autonomy);
  if (!tabId || !previousMode) throw new Error("Host MCP trusted fill requires one renderer-owned active tab and autonomy state");
  const changed = await apiJson(connection, "POST", `/autonomy?tabId=${encodeURIComponent(tabId)}`, { mode: "bypassPermissions", tabId });
  if (changed.ok !== true || changed.tabId !== tabId || changed.mode !== "bypassPermissions") {
    throw new Error("Host MCP trusted fill could not establish exact tab-scoped mutation permission");
  }
  return {
    base: request.runtime.mcpBase.replace(/\/$/, ""),
    token,
    mutationToken: deriveTabBoundToken(token, tabId),
    tabId,
    autonomy: { tabId, previousMode },
  };
}

async function restoreAutonomy(connection: ShellxDebugApiConnection, lease: AutonomyLease): Promise<string | null> {
  try {
    const response = await apiJson(connection, "POST", `/autonomy?tabId=${encodeURIComponent(lease.tabId)}`, {
      mode: lease.previousMode,
      tabId: lease.tabId,
    });
    if (response.ok !== true || response.tabId !== lease.tabId || response.mode !== lease.previousMode) {
      throw new Error("Host MCP trusted fill autonomy restore returned the wrong state");
    }
    return null;
  } catch (error) {
    return `autonomy restore: ${errorText(error)}`;
  }
}

async function proveMcpToolPresent(connection: McpConnection, name: string): Promise<void> {
  const listed = await mcpRequest(connection, "tools/list", {});
  const tools = Array.isArray(listed.tools) ? listed.tools.filter(isRecord) : [];
  if (tools.some((tool) => tool.name === name)) return;
  const search = await callMcpTool(connection, "search_tool", { query: name, limit: 5 }, false);
  const matches = Array.isArray(search.tools) ? search.tools.filter(isRecord) : [];
  if (!matches.some((tool) => tool.name === name && isRecord(tool.inputSchema))) {
    throw new Error("trusted Vault fill tool was absent from the bounded Host MCP catalog");
  }
}

async function callMcpTool(
  connection: McpConnection,
  name: string,
  args: Json,
  mutation = true,
): Promise<Json> {
  const result = await mcpRequest(connection, "tools/call", { name, arguments: args }, mutation);
  rejectRawValues(result, `Host MCP ${name} envelope`);
  if (result.isError === true) throw new Error(`Host MCP ${name} returned a bounded tool error`);
  return record(result.structuredContent, `Host MCP ${name} structured result`);
}

async function mcpRequest(
  connection: McpConnection,
  method: "tools/list" | "tools/call",
  params: Json,
  mutation = false,
): Promise<Json> {
  const id = `shellx-release-trusted-fill-${method.replace("/", "-")}`;
  const response = await fetch(`${connection.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mutation ? connection.mutationToken : connection.token}`,
      "Content-Type": "application/json",
      "MCP-Tab-Id": connection.tabId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(mutation ? 45_000 : 15_000),
  });
  if (!response.ok) throw new Error(`Host MCP ${method} returned HTTP ${response.status}`);
  const envelope = record(await response.json(), `Host MCP ${method} envelope`);
  if (envelope.jsonrpc !== "2.0" || envelope.id !== id || isRecord(envelope.error)) {
    throw new Error(`Host MCP ${method} returned an invalid JSON-RPC envelope`);
  }
  return record(envelope.result, `Host MCP ${method} result`);
}

async function invokeTauri(
  connection: ShellxDebugApiConnection,
  state: LifecycleState,
  command: string,
  args: Json,
): Promise<unknown> {
  const started = await apiJson(connection, "POST", "/release-test/tauri-invokes", { command, args });
  const id = requiredString(started.id, "trusted Vault fill Tauri relay id");
  if (!/^rti-[0-9a-f]{32}$/.test(id) || started.status !== "pending") {
    throw new Error("trusted Vault fill Tauri relay did not return a valid pending identity");
  }
  state.relayIds.push(id);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const relay = await apiJson(connection, "GET", `/release-test/tauri-invokes/${encodeURIComponent(id)}`);
    if (relay.status === "passed") {
      rejectRawValues(relay, "trusted Vault fill Tauri relay");
      return relay.value;
    }
    if (relay.status === "failed") throw new Error("trusted Vault fill Tauri command failed without retaining its error payload");
    await delay(100);
  }
  throw new Error("trusted Vault fill Tauri command did not complete before timeout");
}

function verifyAppliedFillResult(result: Json, taskId: string | null, label: string): void {
  rejectRawValues(result, label);
  if (result.ok !== true || result.status !== "applied"
    || (taskId !== null && result.taskId !== taskId)
    || (result.extractedText !== undefined && result.extractedText !== null)
    || (result.screenshot !== undefined && result.screenshot !== null)) {
    const safeShape = {
      ok: result.ok === true,
      status: typeof result.status === "string" ? result.status.slice(0, 80) : null,
      taskIdMatches: taskId === null || result.taskId === taskId,
      extractedTextState: result.extractedText === undefined
        ? "omitted"
        : result.extractedText === null ? "null" : "present",
      screenshotState: result.screenshot === undefined
        ? "omitted"
        : result.screenshot === null ? "null" : "present",
    };
    throw new Error(`${label} omitted its exact redacted applied result: ${JSON.stringify(safeShape)}`);
  }
}

function rejectRawValues(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized.includes(SECRET_VALUE) || serialized.includes(PROFILE_VALUE)) {
    throw new Error(`${label} exposed a synthetic raw Vault value`);
  }
}

async function clickInput(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(input, await waitForReleaseSurfaceInstalledInputElement(input, selector));
}

async function apiJson(
  connection: ShellxDebugApiConnection,
  method: Method,
  path: string,
  body?: Json,
  additionalHeaders: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<Json> {
  const response = await fetch(`${connection.base.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...additionalHeaders,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned HTTP ${response.status}`);
  const text = await response.text();
  const value = text ? JSON.parse(text) as unknown : {};
  return record(value, `candidate ${method} ${path}`);
}

function deriveTabBoundToken(baseToken: string, tabId: string): string {
  const digest = createHash("sha256")
    .update("shellx-mcp-tab-token-v1\0")
    .update(baseToken)
    .update("\0")
    .update(tabId)
    .digest("hex");
  return `sx_tab_${digest}`;
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Host MCP token path");
  return resolve(result.stdout.trim());
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
    observedEffect: "No trusted HTTPS Vault fill effect was observed.",
  };
}

function finishCleanup(outcome: ReleaseSurfaceDriverOutcome, errors: string[]): void {
  if (errors.length === 0) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${errors.join(" | ")}` : `cleanup: ${errors.join(" | ")}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "trusted Vault fill did not satisfy every verdict";
  }
  return outcome;
}

function fail(outcome: ReleaseSurfaceDriverOutcome, detail: string): ReleaseSurfaceDriverOutcome {
  outcome.error = detail;
  return finalize(outcome);
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try { await action(); } catch (error) { errors.push(errorText(error)); }
}

function record(value: unknown, label: string): Json {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function required(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} is unavailable`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
