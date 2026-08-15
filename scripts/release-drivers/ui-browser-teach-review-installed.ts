import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_RUN_PROFILE_SCHEMA,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "../lib/release-surface-run-profile";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  apiJson,
  browserTeachCallerId,
  cleanupBrowserTeachEvidenceFixture,
  prepareBrowserTeachEvidenceFixture,
  teachRevisionRequest,
  type BrowserTeachDraftIdentity,
  type BrowserTeachEvidenceFixture,
} from "./browser-teach-developer-fixture";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import { basename, resolve, win32 } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import {
  BROWSER_TEACH_CONTROL_SURFACE_IDS,
  BROWSER_TEACH_DEBUG_SURFACE_IDS,
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_CONTROL_ORACLES,
  BROWSER_TEACH_INSTALLED_DEBUG_ORACLE,
  BROWSER_TEACH_INSTALLED_FIXTURE,
} from "./ui-browser-teach-review-installed-assignments";

export {
  BROWSER_TEACH_CONTROL_SURFACE_IDS,
  BROWSER_TEACH_DEBUG_SURFACE_IDS,
  BROWSER_TEACH_INSTALLED_CLEANUP,
  BROWSER_TEACH_INSTALLED_CONTROL_ORACLES,
  BROWSER_TEACH_INSTALLED_DEBUG_ORACLE,
  BROWSER_TEACH_INSTALLED_FIXTURE,
};

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const TIMEOUT_MS = 30_000;
const EVIDENCE_TAB = "[data-debug-id='shellx-browser-right-tab-evidence']";
const EVIDENCE_PANEL = "[data-debug-id='shellx-browser-evidence-panel']";
const EVIDENCE_REFRESH = "[data-debug-id='shellx-browser-evidence-refresh']";
const START_TEACH = "[data-debug-id='shellx-browser-evidence-teach-workflow']";
const REVIEW = "[data-debug-id='shellx-browser-teach-review']";
const GOAL = "[data-debug-id='shellx-browser-teach-goal']";
const RETRY = "[data-debug-id='shellx-browser-teach-retry']";
const RELOAD_STALE = "[data-debug-id='shellx-browser-teach-reload-stale']";
const SAVE = "[data-debug-id='shellx-browser-teach-save-draft']";
const APPROVE = "[data-debug-id='shellx-browser-teach-approve-recipe']";
const REHEARSE = "[data-debug-id='shellx-browser-teach-rehearse']";
const COPY_APPROVAL = "[data-debug-id='shellx-browser-teach-copy-approval-receipt']";
const COPY_REHEARSAL = "[data-debug-id='shellx-browser-teach-copy-rehearsal-receipt']";
const CREATE_TASK = "[data-debug-id='shellx-browser-teach-create-task']";
const COPY_TASK = "[data-debug-id='shellx-browser-teach-copy-task-receipt']";
const ISSUE_ACTION = "[data-debug-id^='shellx-browser-teach-issue-action-']";
const VALUE_LABEL = "[data-debug-id^='shellx-browser-teach-value-label-']";
const VALUE_LITERAL = "[data-debug-id^='shellx-browser-teach-value-literal-']";
const VAULT_BINDING = "[data-debug-id^='shellx-browser-teach-vault-binding-']";
const APPROVAL_RECEIPT = "[data-debug-id='shellx-browser-teach-approval-receipt']";
const REHEARSAL_RECEIPT = "[data-debug-id='shellx-browser-teach-rehearsal-receipt']";
const TASK_HANDOFF_RECEIPT = "[data-debug-id='shellx-browser-teach-task-handoff-receipt']";
const TASK_MANAGER_CLOSE = "[data-debug-id='task-manager-close']";

const CONTROL_BY_SUFFIX = new Map<string, string>([
  ["issue-action-", ISSUE_ACTION],
  ["value-label-", VALUE_LABEL],
  ["value-literal-", VALUE_LITERAL],
  ["vault-binding-", VAULT_BINDING],
  ["approve-recipe\"]", APPROVE],
  ["copy-approval-receipt\"]", COPY_APPROVAL],
  ["copy-rehearsal-receipt\"]", COPY_REHEARSAL],
  ["copy-task-receipt\"]", COPY_TASK],
  ["create-task\"]", CREATE_TASK],
  ["goal\"]", GOAL],
  ["rehearse\"]", REHEARSE],
  ["reload-stale\"]", RELOAD_STALE],
  ["retry\"]", RETRY],
  ["save-draft\"]", SAVE],
]);

type VaultDirectory = { keys: string[]; entries: Array<{ key: string; [key: string]: unknown }> };
type OwnedVaultBinding = { key: string };
type LifecycleProof = {
  controlEffects: Map<string, string>;
  markerEffects: Map<string, string>;
};

/**
 * This deliberately drives the same lifecycle for controls and markers.  The
 * Debug API creates only the owned task/evidence, an optimistic revision
 * conflict, and a redacted Vault key fixture.  Prepare, save, retry, reload,
 * approval, rehearsal, and copy are all native installed input actions.
 */
export async function runBrowserTeachInstalledLifecycle(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
): Promise<LifecycleProof> {
  const proof: LifecycleProof = { controlEffects: new Map(), markerEffects: new Map() };
  let fixture: BrowserTeachEvidenceFixture | null = null;
  let binding: OwnedVaultBinding | null = null;
  let originalWindow: string | null = null;
  let isolatedVaultPrepared = false;
  const vaultRelay = new ReleaseSurfaceTauriInvokeSession(connection);
  const cleanupErrors: string[] = [];
  try {
    verifyIsolatedVaultCandidate(request);
    await prepareIsolatedLockedVault(connection);
    isolatedVaultPrepared = true;
    fixture = await prepareBrowserTeachEvidenceFixture(connection, browserTeachCallerId());
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    originalWindow = switched.originalHandle;

    await nativeClick(input, EVIDENCE_TAB);
    await waitForReleaseSurfaceInstalledInputElement(input, EVIDENCE_PANEL, { timeoutMs: TIMEOUT_MS });
    await nativeClick(input, EVIDENCE_REFRESH);
    await waitEnabled(input, START_TEACH);
    await nativeClick(input, START_TEACH);
    await waitForReleaseSurfaceInstalledInputElement(input, REVIEW, { timeoutMs: TIMEOUT_MS });
    await waitEnabled(input, GOAL);
    await recordMarkers(input, proof, [
      "shellx-browser-teach-review", "shellx-browser-teach-state-*", "shellx-browser-teach-source",
      "shellx-browser-teach-redaction", "shellx-browser-teach-goal", "shellx-browser-teach-action-summary",
      "shellx-browser-teach-blocking", "shellx-browser-teach-issues", "shellx-browser-teach-issue-*",
      "shellx-browser-teach-issue-action-*", "shellx-browser-teach-steps", "shellx-browser-teach-step-*",
      "shellx-browser-teach-values", "shellx-browser-teach-value-*", "shellx-browser-teach-value-label-*",
      "shellx-browser-teach-value-literal-*", "shellx-browser-teach-vault-binding-*",
      "shellx-browser-teach-save-draft", "shellx-browser-teach-rehearse", "shellx-browser-teach-approve-recipe",
      "shellx-browser-teach-create-task",
    ]);
    await recordMarkers(input, proof, ["shellx-browser-teach-vault-unavailable"]);
    await unlockOwnedIsolatedVault(connection, vaultRelay);
    binding = await seedOwnedVaultBinding(connection, request.runtime.instanceId);

    // A blank goal is a bounded UI validation failure.  Retry then repeats the
    // exact native save request after we restore an owned non-secret goal.
    await replaceInput(input, GOAL, "");
    proof.controlEffects.set(GOAL, "Native text entry cleared the owned Teach goal and made Save validate the required workflow goal.");
    await nativeClick(input, SAVE);
    await waitForReleaseSurfaceInstalledInputElement(input, RETRY, { timeoutMs: TIMEOUT_MS });
    await recordMarkers(input, proof, ["shellx-browser-teach-retry", "shellx-browser-teach-state-*"]);
    await replaceInput(input, GOAL, "Confirm owned Browser Teach workflow");
    await nativeClick(input, RETRY);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, RETRY, { timeoutMs: TIMEOUT_MS });
    proof.controlEffects.set(RETRY, "Native Retry repeated the bounded failed save after the operator restored a valid owned goal.");
    proof.controlEffects.set(SAVE, "Native Save persisted an immutable revised draft and returned the review to a current revision.");

    const saved = await readCurrentDraft(connection, fixture, browserTeachCallerId());
    await createAgentRevisionConflict(connection, saved);
    await replaceInput(input, GOAL, "Confirm owned Browser Teach workflow after conflict");
    await nativeClick(input, SAVE);
    await waitForReleaseSurfaceInstalledInputElement(input, RELOAD_STALE, { timeoutMs: TIMEOUT_MS });
    await recordMarkers(input, proof, ["shellx-browser-teach-reload-stale", "shellx-browser-teach-state-*"]);
    await nativeClick(input, RELOAD_STALE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, RELOAD_STALE, { timeoutMs: TIMEOUT_MS });
    proof.controlEffects.set(RELOAD_STALE, "Native Reload replaced the stale local draft with the exact current revision after a controlled compare-and-swap conflict.");

    await nativeClick(input, ISSUE_ACTION);
    proof.controlEffects.set(ISSUE_ACTION, "Native checkbox input resolved the owned redacted-navigation ambiguity without relaxing source-loss handling.");
    await replaceInput(input, VALUE_LABEL, "Owned navigation URL");
    proof.controlEffects.set(VALUE_LABEL, "Native text entry renamed the owned sanitized literal value.");
    await replaceInput(input, VALUE_LITERAL, fixture.browser.url);
    proof.controlEffects.set(VALUE_LITERAL, "Native text entry supplied the exact loopback HTTP URL required to resolve the redacted navigation value.");
    await selectOwnedVaultBinding(input, binding.key);
    proof.controlEffects.set(VAULT_BINDING, "Native choice input bound only the redacted owned Vault key identity; no Vault value was observed or sent through Teach.");
    await replaceInput(input, GOAL, "Rehearse the owned Browser Teach workflow");
    await nativeClick(input, SAVE);
    await waitDisabled(input, APPROVE, false);

    // Approval is intentionally not available on the Debug API.  This click
    // crosses the UI's Tauri-only operator command and yields the receipt.
    await nativeClick(input, APPROVE);
    await waitForReleaseSurfaceInstalledInputElement(input, APPROVAL_RECEIPT, { timeoutMs: TIMEOUT_MS });
    await recordMarkers(input, proof, ["shellx-browser-teach-approval-receipt", "shellx-browser-teach-copy-approval-receipt", "shellx-browser-teach-state-*"]);
    proof.controlEffects.set(APPROVE, "Native operator approval produced one exact Action Recipe receipt; no Debug API approval route was used.");
    await nativeClick(input, COPY_APPROVAL);
    proof.controlEffects.set(COPY_APPROVAL, "Native input copied the approval correlation receipt after approval was visibly present.");

    await nativeClick(input, REHEARSE);
    await waitForReleaseSurfaceInstalledInputElement(input, REHEARSAL_RECEIPT, { timeoutMs: TIMEOUT_MS });
    await recordMarkers(input, proof, ["shellx-browser-teach-rehearsal-receipt", "shellx-browser-teach-copy-rehearsal-receipt", "shellx-browser-teach-state-*"]);
    proof.controlEffects.set(REHEARSE, "Native Rehearse produced a zero-apply dry-run receipt for the exact approved recipe.");
    await nativeClick(input, COPY_REHEARSAL);
    proof.controlEffects.set(COPY_REHEARSAL, "Native input copied the rehearsal correlation receipt after the dry-run receipt was visibly present.");

    await nativeClick(input, CREATE_TASK);
    await waitForReleaseSurfaceInstalledInputElement(input, TASK_HANDOFF_RECEIPT, { timeoutMs: TIMEOUT_MS });
    await recordMarkers(input, proof, [
      "shellx-browser-teach-task-handoff-receipt",
      "shellx-browser-teach-copy-task-receipt",
      "shellx-browser-teach-state-*",
    ]);
    proof.controlEffects.set(CREATE_TASK, "Native Create task draft handed the exact approved and rehearsed workflow receipt to the main ShellX Task Manager without selecting or launching a provider.");
    await nativeClick(input, COPY_TASK);
    proof.controlEffects.set(COPY_TASK, "Native input copied the path-free workflow, handoff receipt, and immutable revision correlation after the Task draft acknowledgement was visible.");
  } finally {
    if (originalWindow) {
      try {
        await switchReleaseSurfaceInstalledInputWindow(input, originalWindow);
        if (proof.controlEffects.has(CREATE_TASK)) {
          await nativeClick(input, TASK_MANAGER_CLOSE);
          await waitForReleaseSurfaceInstalledInputElementAbsent(input, TASK_MANAGER_CLOSE, { timeoutMs: TIMEOUT_MS });
        }
      } catch (error) { cleanupErrors.push(`window restore and Task draft close: ${errorText(error)}`); }
    }
    if (fixture) {
      try {
        const error = await cleanupBrowserTeachEvidenceFixture(connection, fixture);
        if (error) cleanupErrors.push(`owned Browser Teach evidence: ${error}`);
      } catch (error) { cleanupErrors.push(`owned Browser Teach evidence: ${errorText(error)}`); }
    }
    if (binding) {
      try { await cleanupOwnedVaultBinding(connection, binding); } catch (error) { cleanupErrors.push(`owned Vault key: ${errorText(error)}`); }
    }
    if (isolatedVaultPrepared) {
      try { await lockOwnedIsolatedVault(connection); } catch (error) { cleanupErrors.push(`isolated Vault lock: ${errorText(error)}`); }
    }
    try { await vaultRelay.cleanup(); } catch (error) { cleanupErrors.push(`Vault relay: ${errorText(error)}`); }
    if (cleanupErrors.length) throw new Error(`Browser Teach lifecycle cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  return proof;
}

export function browserTeachControlOutcomes(assignments: readonly Assignment[], proof: LifecycleProof): ReleaseSurfaceDriverOutcome[] {
  assertExactAssignments(assignments, BROWSER_TEACH_CONTROL_SURFACE_IDS, "ui-control");
  return assignments.map((assignment) => {
    const selector = controlSelector(assignment.surface.id);
    const effect = proof.controlEffects.get(selector);
    if (!effect) throw new Error(`Browser Teach lifecycle did not execute ${assignment.surface.id}`);
    return passedOutcome(assignment, effect);
  });
}

export function browserTeachDebugOutcomes(assignments: readonly Assignment[], proof: LifecycleProof): ReleaseSurfaceDriverOutcome[] {
  const ids = new Set(assignments.map((assignment) => debugMarkerFromSurfaceId(assignment.surface.id)));
  if (assignments.length !== BROWSER_TEACH_DEBUG_SURFACE_IDS.size || ids.size !== BROWSER_TEACH_DEBUG_SURFACE_IDS.size
    || [...BROWSER_TEACH_DEBUG_SURFACE_IDS].some((id) => !ids.has(id))) {
    throw new Error(`Browser Teach debug driver requires exactly its ${BROWSER_TEACH_DEBUG_SURFACE_IDS.size} static/dynamic marker assignments`);
  }
  return assignments.map((assignment) => {
    const marker = debugMarkerFromSurfaceId(assignment.surface.id);
    const effect = proof.markerEffects.get(marker);
    if (!effect) throw new Error(`Browser Teach lifecycle did not make marker ${marker} visible`);
    return passedOutcome(assignment, effect);
  });
}

function passedOutcome(assignment: Assignment, observedEffect: string): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "pass",
    invoke: "pass",
    effect: "pass",
    cleanup: "pass",
    observedEffect,
  };
}

function assertExactAssignments(assignments: readonly Assignment[], expected: Set<string>, kind: string): void {
  const ids = new Set(assignments.map((assignment) => assignment.surface.id));
  if (assignments.length !== expected.size || ids.size !== expected.size || [...expected].some((id) => !ids.has(id))) {
    throw new Error(`Browser Teach ${kind} driver requires exactly ${expected.size} assigned surfaces`);
  }
}

function controlSelector(surfaceId: string): string {
  for (const [suffix, selector] of CONTROL_BY_SUFFIX) if (surfaceId.includes(suffix)) return selector;
  throw new Error(`Browser Teach control selector is not registered for ${surfaceId}`);
}

function debugMarkerFromSurfaceId(surfaceId: string): string {
  const match = /^ui-debug-surface:(shellx-browser-teach-[^@]+)@/.exec(surfaceId);
  if (!match || !BROWSER_TEACH_DEBUG_SURFACE_IDS.has(match[1]!)) throw new Error(`unsupported Browser Teach debug surface ${surfaceId}`);
  return match[1]!;
}

function markerSelector(marker: string): string {
  return marker.endsWith("*")
    ? `[data-debug-id^='${marker.slice(0, -1)}']`
    : `[data-debug-id='${marker}']`;
}

async function recordMarkers(input: ReleaseSurfaceInstalledInputSession, proof: LifecycleProof, markers: readonly string[]): Promise<void> {
  for (const marker of markers) {
    await waitForReleaseSurfaceInstalledInputElement(input, markerSelector(marker), { timeoutMs: TIMEOUT_MS });
    proof.markerEffects.set(marker, `The native installed Browser Teach lifecycle rendered ${marker} in a visible owned state.`);
  }
}

async function nativeClick(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clickReleaseSurfaceInstalledInputElement(input, element);
}

async function replaceInput(input: ReleaseSurfaceInstalledInputSession, selector: string, value: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: TIMEOUT_MS });
  await clearReleaseSurfaceInstalledInputElement(input, element);
  if (value) await setReleaseSurfaceInstalledInputElementValue(input, element, value);
  await waitValue(input, selector, value);
}

async function selectOwnedVaultBinding(input: ReleaseSurfaceInstalledInputSession, key: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, VAULT_BINDING, { timeoutMs: TIMEOUT_MS });
  await clickReleaseSurfaceInstalledInputElement(input, element);
  await setReleaseSurfaceInstalledInputElementValue(input, element, key);
  await waitValue(input, VAULT_BINDING, key);
}

async function waitEnabled(input: ReleaseSurfaceInstalledInputSession, selector: string): Promise<void> {
  await waitDisabled(input, selector, false);
}

async function waitDisabled(input: ReleaseSurfaceInstalledInputSession, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(input, selector, ["disabled"]);
    if (observed.present && observed.visible && observed.disabled === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach disabled=${expected}`);
}

async function waitValue(input: ReleaseSurfaceInstalledInputSession, selector: string, expected: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(input, selector, ["value"]);
    if (observed.present && observed.visible && observed.value === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach its exact owned value`);
}

async function readCurrentDraft(connection: Connection, fixture: BrowserTeachEvidenceFixture, callerId: string): Promise<BrowserTeachDraftIdentity> {
  const value = await apiJson(connection, "GET", `/browser/teach/drafts?taskId=${encodeURIComponent(fixture.browser.taskId)}&limit=1`, undefined, callerId);
  if (value.taskId !== fixture.browser.taskId || !Array.isArray(value.drafts) || value.drafts.length !== 1) {
    throw new Error("Browser Teach draft list did not return the exact owned current draft");
  }
  const draft = record(value.drafts[0], "Browser Teach current draft");
  const draftId = string(draft.draftId, "Browser Teach current draftId");
  const revisionId = string(draft.currentRevisionId, "Browser Teach current revisionId");
  const revisionSha256 = string(draft.currentRevisionSha256, "Browser Teach current revisionSha256");
  if (draft.taskId !== fixture.browser.taskId || draft.browserTabId !== fixture.browser.browserTabId
    || draft.attemptId !== fixture.attemptId || !/^[a-f0-9]{64}$/i.test(revisionSha256)) {
    throw new Error("Browser Teach draft list lost the exact owned task, tab, attempt, or revision identity");
  }
  return { draftId, revisionId, revisionSha256 };
}

async function createAgentRevisionConflict(connection: Connection, draft: BrowserTeachDraftIdentity): Promise<void> {
  const response = await apiJson(connection, "POST", "/browser/teach/revise", teachRevisionRequest(draft), browserTeachCallerId());
  const revision = record(response.revision, "Browser Teach conflict revision");
  if (revision.parentRevisionId !== draft.revisionId || revision.revisionId === draft.revisionId
    || typeof revision.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(revision.sha256)) {
    throw new Error("controlled Browser Teach conflict did not advance the exact current revision");
  }
}

const SYNTHETIC_VAULT_PASSPHRASE = "ShellX-BrowserTeach-Review-0352";

function verifyIsolatedVaultCandidate(request: ReleaseSurfaceDriverRequest): void {
  const root = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const rootName = request.platform === "windows-installed" ? win32.basename(root) : basename(root);
  const runId = /^shellx-final-webdriver-([a-f0-9]{16,64})$/.exec(rootName)?.[1];
  if (!runId || request.runtime.instanceId !== `shellx-final-${runId}`) {
    throw new Error("Browser Teach Vault fixture requires the exact attested disposable final-candidate profile");
  }
  const markerPath = releaseSurfaceProfileMarkerLaunchPath(request.runtime.debugTokenPath, request.platform);
  const markerStat = lstatSync(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > 16_384) {
    throw new Error("Browser Teach Vault fixture requires one bounded regular final-candidate profile marker");
  }
  const marker = record(JSON.parse(readFileSync(markerPath, "utf8")), "Browser Teach final-candidate profile marker");
  if (marker.schema !== RELEASE_SURFACE_RUN_PROFILE_SCHEMA || marker.platform !== request.platform
    || marker.runId !== runId || marker.launchPath !== root) {
    throw new Error("Browser Teach Vault fixture profile marker does not bind to the attested candidate root");
  }
  if (resolve(markerPath) !== resolve(
    request.platform === "windows-installed" ? win32.join(root, "shellx-final-profile.json") : `${root}/shellx-final-profile.json`,
  )) {
    throw new Error("Browser Teach Vault fixture marker escaped the attested candidate root");
  }
}

async function prepareIsolatedLockedVault(connection: Connection): Promise<void> {
  const initial = await readVaultStatus(connection);
  if (initial.mode !== "unconfigured" || initial.unlocked || initial.recoveryConfirmed || !initial.rememberedDeviceEnabled) {
    throw new Error("Browser Teach Vault fixture refuses a configured or shared Vault profile");
  }
  const started = await vaultJson(connection, "POST", "/vault/setup/begin", {
    target: "local",
    passphrase: SYNTHETIC_VAULT_PASSPHRASE,
    rememberDevice: false,
  });
  const recoveryKit = record(started.recoveryKit, "Browser Teach disposable Vault recovery kit");
  const confirmationId = string(recoveryKit.confirmationId, "Browser Teach disposable Vault confirmation ID");
  if (started.ok !== true || !/^[0-9a-f]{32}$/.test(confirmationId)) {
    throw new Error("Browser Teach disposable Vault setup did not return a valid bounded confirmation identity");
  }
  const confirmed = await vaultJson(connection, "POST", "/vault/setup/confirm-recovery", {
    confirmationId,
    importLegacy: false,
  });
  if (confirmed.ok !== true) throw new Error("Browser Teach disposable Vault recovery confirmation failed");
  const configured = await readVaultStatus(connection);
  if (configured.mode !== "local" || !configured.unlocked || !configured.recoveryConfirmed
    || configured.rememberedDeviceEnabled) {
    throw new Error("Browser Teach Vault fixture did not create its exact unlocked disposable local Vault");
  }
  await lockOwnedIsolatedVault(connection);
}

async function unlockOwnedIsolatedVault(
  connection: Connection,
  relay: ReleaseSurfaceTauriInvokeSession,
): Promise<void> {
  await relay.invoke("shellx_vault_unlock", {
    request: {
      passphrase: SYNTHETIC_VAULT_PASSPHRASE,
      keyfileJson: null,
      rememberDevice: false,
    },
  });
  const status = await readVaultStatus(connection);
  if (status.mode !== "local" || !status.unlocked || !status.recoveryConfirmed
    || status.rememberedDeviceEnabled) {
    throw new Error("Browser Teach disposable Vault did not unlock after the unavailable-marker proof");
  }
}

async function lockOwnedIsolatedVault(connection: Connection): Promise<void> {
  const locked = await vaultJson(connection, "POST", "/vault/lock", {});
  if (locked.ok !== true || locked.unlocked !== false || locked.rememberedDeviceEnabled !== false) {
    throw new Error("Browser Teach disposable Vault did not return to its exact locked state");
  }
  const status = await readVaultStatus(connection);
  if (status.mode !== "local" || status.unlocked || !status.recoveryConfirmed
    || status.rememberedDeviceEnabled) {
    throw new Error("Browser Teach disposable Vault lock readback was not exact");
  }
}

type VaultStatus = {
  mode: string;
  unlocked: boolean;
  recoveryConfirmed: boolean;
  rememberedDeviceEnabled: boolean;
};

async function readVaultStatus(connection: Connection): Promise<VaultStatus> {
  const value = await vaultJson(connection, "GET", "/vault/status");
  if (!["unconfigured", "local", "external"].includes(String(value.mode))
    || typeof value.unlocked !== "boolean" || typeof value.recoveryConfirmed !== "boolean"
    || typeof value.rememberedDeviceEnabled !== "boolean") {
    throw new Error("Browser Teach Vault status was not a bounded metadata-only response");
  }
  return value as VaultStatus;
}

async function vaultJson(
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.includes(SYNTHETIC_VAULT_PASSPHRASE)) {
    throw new Error("Browser Teach disposable Vault response exposed synthetic setup material");
  }
  if (!response.ok) throw new Error(`Browser Teach disposable Vault ${method} ${path} failed with ${response.status}`);
  try {
    return record(text.trim() ? JSON.parse(text) : {}, `Browser Teach disposable Vault ${method} ${path}`);
  } catch {
    throw new Error(`Browser Teach disposable Vault ${method} ${path} returned invalid JSON`);
  }
}

async function seedOwnedVaultBinding(connection: Connection, instanceId: string): Promise<OwnedVaultBinding> {
  const key = `release-surface-browser-teach-${safeId(instanceId)}-binding`;
  const baseline = await readVaultDirectory(connection);
  if (baseline.keys.length !== 0 || baseline.entries.length !== 0 || baseline.keys.includes(key)) {
    throw new Error("Browser Teach disposable Vault did not start with an empty post-unlock directory");
  }
  const response = await apiJson(connection, "POST", "/vault/set", {
    key,
    value: "SHELLX_RELEASE_BROWSER_TEACH_BOUNDARY_VALUE",
    description: "Disposable Browser Teach key identity fixture",
    userOnly: false,
  });
  if (response.ok !== true || response.key !== key || JSON.stringify(response).includes("BOUNDARY_VALUE")) {
    throw new Error("Browser Teach Vault fixture did not return a redacted owned-key acknowledgement");
  }
  const after = await readVaultDirectory(connection);
  if (!after.keys.includes(key) || !after.entries.some((entry) => entry.key === key)) {
    throw new Error("Browser Teach Vault fixture did not expose its redacted key identity");
  }
  return { key };
}

async function cleanupOwnedVaultBinding(connection: Connection, binding: OwnedVaultBinding): Promise<void> {
  const current = await readVaultDirectory(connection);
  if (current.keys.includes(binding.key) || current.entries.some((entry) => entry.key === binding.key)) {
    const deleted = await apiJson(connection, "POST", "/vault/delete", { key: binding.key });
    if (deleted.ok !== true || deleted.key !== binding.key) throw new Error("Browser Teach owned Vault key delete was not acknowledged");
  }
  const restored = await readVaultDirectory(connection);
  if (restored.keys.length !== 0 || restored.entries.length !== 0) {
    throw new Error("Browser Teach owned Vault key cleanup left a non-empty disposable directory");
  }
}

async function readVaultDirectory(connection: Connection): Promise<VaultDirectory> {
  const value = await apiJson(connection, "GET", "/vault/keys");
  if (!Array.isArray(value.keys) || !Array.isArray(value.entries)
    || value.keys.some((key) => typeof key !== "string" || !key)
    || value.entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).key !== "string")
    || /"(?:value|secret)"\s*:/.test(JSON.stringify(value))) {
    throw new Error("Browser Teach Vault directory was not a redacted key-only listing");
  }
  return value as VaultDirectory;
}

function safeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 80);
  if (!normalized) throw new Error("Browser Teach instance ID is invalid");
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
