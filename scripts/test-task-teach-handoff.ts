import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserTeachTaskHandoffMatchesNativeState,
  normalizeBrowserTeachTaskHandoff,
  normalizeBrowserTeachTaskHandoffResult,
  TASK_TEACH_HANDOFF_EVENT,
  TASK_TEACH_HANDOFF_RESULT_EVENT,
} from "../src/lib/task-teach-handoff-events";
import { taskSaveDisabledReason } from "../src/lib/task-manager-contract";
import { normalizeTaskVaultGrants } from "../src/lib/task-manager-controller";
import { createBrowserTeachTaskDraft } from "../src/lib/task-manager-tauri-adapter";
import { TASK_MANAGER_FIXTURE_DATA } from "../src/lib/task-manager-fixtures";

const digest = `sha256:${"a".repeat(64)}`;
const handoff = normalizeBrowserTeachTaskHandoff({
  requestId: "teach-task-handoff-1",
  workflowId: "browser-workflow-1",
  workflowDigest: digest,
  goal: "Submit the reviewed account form",
  ownerSessionId: "tab-source-1",
  browserTaskId: "browser-task-1",
  browserTabId: "browser-tab-1",
  requiredVaultKeyIds: ["accounts/example/email"],
  requiredCapabilities: ["browser.native"],
  receipt: {
    receiptId: "browser-receipt-1",
    kind: "browserTeachTaskHandoffPrepared",
    createdAtMs: 100,
    sequence: 5,
    path: "/private/must-not-project",
  },
  recipePath: "/private/must-not-project",
});
assert(handoff, "exact path-free Teach Task handoff must normalize");
assert.equal(JSON.stringify(handoff).includes("private"), false);
assert.equal(normalizeBrowserTeachTaskHandoff({ ...handoff, workflowDigest: "a".repeat(64) }), null);
assert.equal(normalizeBrowserTeachTaskHandoff({ ...handoff, requiredVaultKeyIds: ["duplicate", "duplicate"] }), null);
assert.equal(normalizeBrowserTeachTaskHandoffResult({ requestId: handoff.requestId, ok: false }), null);
assert.deepEqual(normalizeBrowserTeachTaskHandoffResult({ requestId: handoff.requestId, ok: true }), {
  requestId: handoff.requestId,
  ok: true,
  error: undefined,
});
assert.equal(TASK_TEACH_HANDOFF_EVENT, "shellx:task-teach-handoff");
assert.equal(TASK_TEACH_HANDOFF_RESULT_EVENT, "shellx:task-teach-handoff-result");
const nativeState = {
  tasks: [{ taskId: handoff.browserTaskId, ownerSessionId: handoff.ownerSessionId }],
  bookmarks: [{ bookmarkId: handoff.workflowId }],
  receipts: [{
    receiptId: handoff.receipt.receiptId,
    kind: handoff.receipt.kind,
    taskId: handoff.browserTaskId,
    t: handoff.receipt.createdAtMs,
    sequence: handoff.receipt.sequence,
    evidence: {
      requestId: handoff.requestId,
      workflowId: handoff.workflowId,
      workflowDigest: handoff.workflowDigest,
      goal: handoff.goal,
      ownerSessionId: handoff.ownerSessionId,
      browserTabId: handoff.browserTabId,
      requiredVaultKeyIds: handoff.requiredVaultKeyIds,
      requiredCapabilities: handoff.requiredCapabilities,
      source: "shellx-browser-teach",
    },
  }],
};
const nativeReceipt = nativeState.receipts[0]!;
assert.equal(browserTeachTaskHandoffMatchesNativeState(handoff, nativeState), true);
assert.equal(browserTeachTaskHandoffMatchesNativeState(handoff, {
  ...nativeState,
  receipts: [{ ...nativeReceipt, evidence: { ...nativeReceipt.evidence, goal: "spoofed" } }],
}), false, "main workspace must refuse any event not bound to the exact native handoff receipt");

const draft = createBrowserTeachTaskDraft({
  requestId: handoff.requestId,
  tabId: handoff.ownerSessionId,
  sessionId: "provider-session-1",
  connectionKey: "local",
  canonicalCwd: "/workspace/shellx",
  projectId: "shellx",
  agentSuggestion: "grok",
  permissionMode: "default",
  autonomyMode: "default",
  toolExposureIds: ["nativeFirst"],
  attachmentRefs: [],
  visiblePrompt: handoff.goal,
  suggestedName: handoff.goal,
  timezone: "Europe/Riga",
  workflow: { workflowId: handoff.workflowId, digest: handoff.workflowDigest },
  vaultKeyIds: handoff.requiredVaultKeyIds,
});
assert.equal(draft.enabled, false, "Teach handoff must open paused");
assert.deepEqual(draft.candidates, [], "Teach handoff must never select a provider route");
assert.deepEqual(draft.context?.workflow, { workflowId: handoff.workflowId, digest });
assert.deepEqual(draft.context?.vaultRequirements, [{ keyId: "accounts/example/email" }]);

const grants = normalizeTaskVaultGrants([{
  grantId: "grant-active-1",
  secretRef: "accounts/example/email",
  actorScope: JSON.stringify({ kind: "allShellxAgents" }),
  operation: "fill",
  origin: "https://example.test",
  expiresAtMs: 200,
  revoked: false,
  approved: true,
}, {
  grantId: "grant-user-only",
  secretRef: "accounts/example/email",
  actorScope: JSON.stringify({ kind: "user" }),
  operation: "rawReveal",
  revoked: false,
  approved: true,
}], 100);
assert.deepEqual(grants, [{
  grantId: "grant-active-1",
  keyId: "accounts/example/email",
  operation: "fill",
  origin: "https://example.test",
  expiresAtMs: 200,
}]);
const enabledWithoutGrant = {
  ...draft,
  enabled: true,
  candidates: [{ providerId: "grok", modelMode: "providerDefault" as const, order: 1 }],
};
assert.equal(
  taskSaveDisabledReason(enabledWithoutGrant, TASK_MANAGER_FIXTURE_DATA, 100),
  "Enable requires an active mediated Vault grant for every reviewed Vault key.",
);
assert.equal(
  taskSaveDisabledReason({
    ...enabledWithoutGrant,
    context: {
      ...enabledWithoutGrant.context!,
      vaultRequirements: [{ keyId: "accounts/example/email", grantId: "grant-expired-or-revoked" }],
    },
  }, {
    ...TASK_MANAGER_FIXTURE_DATA,
    vaultGrantOptions: grants,
  }, 100),
  "Enable requires an active mediated Vault grant for every reviewed Vault key.",
  "a stored but unavailable grant identity must not satisfy the active grant gate",
);

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const browserHook = readFileSync(new URL("../src/browser/hooks/useBrowserTeach.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/lib/task-teach-handoff-bridge.ts", import.meta.url), "utf8");
const manager = readFileSync(new URL("../src/components/TaskManager.tsx", import.meta.url), "utf8");
assert(app.includes("tabsRef.current.find((tab) => tab.tabId === handoff.ownerSessionId)"));
assert(!app.includes("tabsRef.current.find((tab) => tab.tabId === handoff.ownerSessionId) ?? activeTab"));
assert(app.includes("browserTeachTaskHandoffMatchesNativeState(handoff, browserState)"));
assert(browserHook.includes("rehearsal.stepsSkipped !== 0"));
assert(browserHook.includes("rehearsalReceiptId: rehearsal.receipt.receiptId"));
assert(bridge.includes("WebviewWindow.getByLabel(MAIN_WINDOW_LABEL)"));
assert(bridge.includes("TASK_TEACH_HANDOFF_RESULT_EVENT"));
assert(bridge.includes("const settled = new Map"), "main handoff bridge must replay acknowledgements without reopening duplicate drafts");
assert(bridge.includes("if (ok) {\n          settled.set"), "failed handoffs must remain retryable instead of being cached as final acknowledgements");
assert(bridge.includes("main.setFocus()).catch(() => undefined)"), "window focus must be best-effort while the native acknowledgement remains authoritative");
assert(bridge.includes("if (settled.size > 64)"), "handoff acknowledgement replay state must remain bounded");
for (const marker of [
  "task-manager-reviewed-bindings",
  "task-manager-workflow-binding",
  "task-manager-vault-binding",
  "task-manager-open-vault",
]) assert(manager.includes(marker), `Task Manager must expose ${marker}`);
assert(manager.includes('data-debug-id="task-manager-vault-grant" data-task-vault-key={requirement.keyId}'), "Vault grant control must keep a stable driver ID and expose its reviewed key separately");

console.log("Teach-to-Task handoff passed: exact receipt normalization, source-tab binding, paused provider-neutral draft, active mediated Vault grants, and acknowledged window delivery.");
