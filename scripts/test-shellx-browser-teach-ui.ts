import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BROWSER_TEACH_BUNDLE_SCHEMA,
  BROWSER_TEACH_REVISION_SCHEMA,
  browserTeachErrorMessage,
  browserTeachHasBlockingIssues,
  normalizeBrowserTeachApproval,
  normalizeBrowserTeachPreparedDraft,
  normalizeBrowserTeachRehearsal,
  normalizeBrowserTeachRevisionResponse,
  selectBrowserTeachSource,
} from "../src/browser/browserTeach";
import type { BrowserEvidenceRow } from "../src/browser/browserEvidence";

function check(condition: boolean, message: string): void {
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

const hash = (character: string): string => character.repeat(64);

function exactPrepareResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle: {
      schemaVersion: BROWSER_TEACH_BUNDLE_SCHEMA,
      bundleId: "bundle-1",
      createdAtMs: 100,
      bytes: 4096,
      sha256: hash("a"),
      path: "/private/never-render-this-bundle.json",
      source: {
        attemptId: "attempt-1",
        taskId: "task-1",
        browserTabId: "tab-1",
        bytes: 1024,
        sha256: hash("b"),
        createdAtMs: 90,
        ownerSessionId: "operator",
        evidenceComplete: true,
        path: "C:\\private\\never-render-this-attempt.json",
      },
      steps: [{
        stepId: "step-1",
        sourceSequence: 1,
        operation: "navigate",
        classification: "action",
        targetRef: "must-not-render-this-target",
        valueRefs: ["value-url-1"],
        assertionRefs: [],
        decisionPointRefs: [],
        evidenceRefs: ["evidence-1"],
        recipeStep: { url: "must-not-render-this-recipe" },
      }],
      values: [{
        valueId: "value-url-1",
        label: "Navigation URL",
        kind: "sanitizedLiteral",
        literal: "https://example.test/[redacted-path]",
        requiredVaultBinding: false,
        sourceEvidenceRefs: ["evidence-1"],
      }, {
        valueId: "value-vault-1",
        label: "Fill input 2",
        kind: "vaultBinding",
        literal: null,
        requiredVaultBinding: true,
        sourceEvidenceRefs: ["evidence-2"],
      }],
      ambiguities: [{
        issueId: "issue-redacted-url-1",
        code: "redactedNavigationPath",
        blocking: true,
        sourceSequence: 1,
        detail: "Navigation path is redacted; replace the named URL value with a safe HTTP(S) URL",
        path: "/private/issue-detail",
      }],
      loss: [],
      redactionReceipt: {
        sourceArtifactRedactionVerified: true,
        rawSecrets: false,
        cookies: false,
        headers: false,
        queryAndFragments: false,
        pageBodies: false,
        screenshots: false,
        receiptId: "must-not-invent-or-render-this",
      },
    },
    revision: {
      schemaVersion: BROWSER_TEACH_REVISION_SCHEMA,
      revisionId: "bundle-1-r1",
      revision: 1,
      parentRevisionId: null,
      bundleId: "bundle-1",
      bundleSha256: hash("a"),
      goal: "Review the completed order form",
      steps: [{ stepId: "step-1", sourceSequence: 1, operation: "navigate", classification: "action", valueRefs: ["value-url-1"], evidenceRefs: ["evidence-1"] }],
      values: [{ valueId: "value-url-1", label: "Navigation URL", kind: "sanitizedLiteral", literal: "https://example.test/[redacted-path]", requiredVaultBinding: false, sourceEvidenceRefs: ["evidence-1"] }, { valueId: "value-vault-1", label: "Fill input 2", kind: "vaultBinding", literal: null, requiredVaultBinding: true, sourceEvidenceRefs: ["evidence-2"] }],
      requiredVaultBindings: [{ valueId: "value-vault-1", bindingId: null }],
      requiredCapabilities: ["browser.native"],
      ambiguityResolutions: [],
      actionSummary: { reads: 0, derives: 0, actions: 1, assertions: 0, decisionPoints: 0, blockingIssues: 1 },
      revisionNote: "must-not-render-this-note",
      authorSurface: "operator",
      createdAtMs: 100,
      bytes: 2048,
      sha256: hash("c"),
    },
    draft: {
      draftId: "draft-1",
      bundleId: "bundle-1",
      bundleSha256: hash("a"),
      taskId: "task-1",
      browserTabId: "tab-1",
      attemptId: "attempt-1",
      currentRevisionId: "bundle-1-r1",
      currentRevisionSha256: hash("c"),
      revision: 1,
      stepCount: 1,
      valueCount: 2,
      blockingIssues: 1,
      createdAtMs: 100,
    },
    ...overrides,
  };
}

console.log("\n=== ShellX Browser Teach review UI ===");
const prepared = normalizeBrowserTeachPreparedDraft(exactPrepareResponse());
check(prepared.isCurrent && prepared.draft.draftId === "draft-1", "accepts exact T1 prepare response bundle, revision, and draft identities");
check(prepared.bundle.source.browserTabId === "tab-1" && prepared.bundle.redactionReceipt.sourceArtifactRedactionVerified, "keeps exact source identity and top-level verified redaction receipt without inventing a receipt ID");
check(prepared.revision.values[0]?.literal === "https://example.test/[redacted-path]" && prepared.revision.values[1]?.requiredVaultBinding === true, "keeps editable sanitized literal and Vault-bound named-value contracts");
check(prepared.bundle.ambiguities[0]?.issueId === "issue-redacted-url-1" && prepared.bundle.ambiguities[0]?.blocking === true, "keeps actionable blocking ambiguity identity and sanitized detail");
check(!JSON.stringify(prepared).includes("private") && !JSON.stringify(prepared).includes("must-not-render"), "drops private paths, recipe projections, revision notes, and redaction extras at the UI boundary");
check(browserTeachHasBlockingIssues(prepared), "blocks approval before redacted navigation ambiguity and required Vault binding are resolved");

const lossCannotBeResolved = normalizeBrowserTeachPreparedDraft(exactPrepareResponse({
  bundle: {
    ...(exactPrepareResponse().bundle as Record<string, unknown>),
    ambiguities: [],
    loss: [{ issueId: "issue-loss-1", code: "unsupportedOperation", blocking: true, sourceSequence: 3, detail: "Unsupported source action" }],
  },
  revision: {
    ...(exactPrepareResponse().revision as Record<string, unknown>),
    ambiguityResolutions: ["issue-loss-1"],
  },
}));
check(browserTeachHasBlockingIssues(lossCannotBeResolved), "keeps blocking source loss unresolved even if stale UI state contains its issue ID");

const falselyResolved = normalizeBrowserTeachPreparedDraft(exactPrepareResponse({
  revision: {
    ...(exactPrepareResponse().revision as Record<string, unknown>),
    requiredVaultBindings: [{ valueId: "value-vault-1", bindingId: "vault-key-1" }],
    ambiguityResolutions: ["issue-redacted-url-1"],
    actionSummary: { reads: 0, derives: 0, actions: 1, assertions: 0, decisionPoints: 0, blockingIssues: 0 },
  },
}));
check(browserTeachHasBlockingIssues(falselyResolved), "keeps approval blocked when a checked redacted-navigation issue still lacks its safe URL replacement");

const resolvedResponse = exactPrepareResponse({
  revision: {
    ...(exactPrepareResponse().revision as Record<string, unknown>),
    revisionId: "bundle-1-r2",
    revision: 2,
    sha256: hash("d"),
    values: [{ valueId: "value-url-1", label: "Navigation URL", kind: "sanitizedLiteral", literal: "https://example.test/checkout", requiredVaultBinding: false, sourceEvidenceRefs: ["evidence-1"] }, { valueId: "value-vault-1", label: "Fill input 2", kind: "vaultBinding", literal: null, requiredVaultBinding: true, sourceEvidenceRefs: ["evidence-2"] }],
    requiredVaultBindings: [{ valueId: "value-vault-1", bindingId: "vault-key-1" }],
    ambiguityResolutions: ["issue-redacted-url-1"],
    actionSummary: { reads: 0, derives: 0, actions: 1, assertions: 0, decisionPoints: 0, blockingIssues: 0 },
  },
  draft: {
    ...(exactPrepareResponse().draft as Record<string, unknown>),
    currentRevisionId: "bundle-1-r2",
    currentRevisionSha256: hash("d"),
    revision: 2,
  },
});
const resolved = normalizeBrowserTeachPreparedDraft(resolvedResponse);
check(!browserTeachHasBlockingIssues(resolved), "permits approval only after the safe navigation literal, ambiguity resolution, and Vault key identity are saved");

const localIpv6 = normalizeBrowserTeachPreparedDraft({
  ...resolvedResponse,
  revision: {
    ...(resolvedResponse.revision as Record<string, unknown>),
    values: [{ valueId: "value-url-1", label: "Navigation URL", kind: "sanitizedLiteral", literal: "https://[::1]/checkout", requiredVaultBinding: false, sourceEvidenceRefs: ["evidence-1"] }, { valueId: "value-vault-1", label: "Fill input 2", kind: "vaultBinding", literal: null, requiredVaultBinding: true, sourceEvidenceRefs: ["evidence-2"] }],
  },
});
check(!browserTeachHasBlockingIssues(localIpv6), "accepts a safe query-free local IPv6 workflow in the local desktop Browser");

const localHost = normalizeBrowserTeachPreparedDraft({
  ...resolvedResponse,
  revision: {
    ...(resolvedResponse.revision as Record<string, unknown>),
    values: [{ valueId: "value-url-1", label: "Navigation URL", kind: "sanitizedLiteral", literal: "http://localhost:3000/checkout", requiredVaultBinding: false, sourceEvidenceRefs: ["evidence-1"] }, { valueId: "value-vault-1", label: "Fill input 2", kind: "vaultBinding", literal: null, requiredVaultBinding: true, sourceEvidenceRefs: ["evidence-2"] }],
  },
});
check(!browserTeachHasBlockingIssues(localHost), "accepts a safe query-free localhost workflow in the local desktop Browser");

const revised = normalizeBrowserTeachRevisionResponse({ revision: resolvedResponse.revision, draft: resolvedResponse.draft }, prepared.bundle);
check(revised.revision.revisionId === "bundle-1-r2" && revised.draft.currentRevisionSha256 === hash("d"), "normalizes exact T1 revise response without requiring a repeated bundle");

for (const [label, response] of [
  ["unsafe redaction receipt", exactPrepareResponse({ bundle: { ...(exactPrepareResponse().bundle as Record<string, unknown>), redactionReceipt: { sourceArtifactRedactionVerified: true, rawSecrets: true, cookies: false, headers: false, queryAndFragments: false, pageBodies: false, screenshots: false } } })],
  ["unbounded revision steps", exactPrepareResponse({ revision: { ...(exactPrepareResponse().revision as Record<string, unknown>), steps: Array.from({ length: 101 }, () => ({ stepId: "step-1", sourceSequence: 1, operation: "navigate", classification: "action", valueRefs: [], evidenceRefs: [] })) } })],
] as const) {
  assert.throws(() => normalizeBrowserTeachPreparedDraft(response));
  console.log(`  ✓ rejects ${label}`);
}

const stale = normalizeBrowserTeachPreparedDraft(exactPrepareResponse({ draft: { ...(exactPrepareResponse().draft as Record<string, unknown>), currentRevisionId: "bundle-1-r2", currentRevisionSha256: hash("d") } }));
check(!stale.isCurrent, "marks a draft stale when T1 reports a different current revision identity");

const approval = normalizeBrowserTeachApproval({
  recipe: { recipeId: "recipe-1", taskId: "task-1", browserTabId: "tab-1", bytes: 2048, sha256: hash("e"), steps: 1, source: "shellx-browser-teach", createdAtMs: 200, path: "/private/recipe.json" },
  approval: { approvalId: "approval-1", draftId: "draft-1", revisionId: "bundle-1-r2", recipeId: "recipe-1", createdAtMs: 200, status: "approved", summary: "must-not-render" },
});
check(approval.recipeId === "recipe-1" && approval.approvalId === "approval-1" && !JSON.stringify(approval).includes("private"), "keeps exact Action Recipe identity and T1 approvalId without a private recipe path");

const rehearsal = normalizeBrowserTeachRehearsal({
  recipeId: "recipe-1",
  sha256: hash("e"),
  dryRun: true,
  stepsPlanned: 3,
  stepsSkipped: 1,
  stepsApplied: 0,
  path: "/private/recipe.json",
  receipt: { receiptId: "rehearsal-1", kind: "browserTeachRecipeRehearsed", createdAtMs: 210, sequence: 4, path: "/private/receipt.json" },
});
check(rehearsal.dryRun && rehearsal.stepsApplied === 0 && rehearsal.receipt.receiptId === "rehearsal-1" && !JSON.stringify(rehearsal).includes("private"), "keeps the exact path-free T1 dry-run rehearsal receipt identity");
assert.throws(() => normalizeBrowserTeachRehearsal({ recipeId: "recipe-1", sha256: hash("e"), dryRun: false, stepsPlanned: 3, stepsSkipped: 1, stepsApplied: 1, receipt: { receiptId: "rehearsal-1", kind: "browserTeachRecipeRehearsed", createdAtMs: 210, sequence: 4 } }));
console.log("  ✓ rejects any rehearsal response that could have applied Browser actions");

const attemptRow = (attemptId: string, taskId: string, recordedAtMs: number, evidenceComplete: boolean): BrowserEvidenceRow => ({
  receiptId: `receipt-${attemptId}`,
  kind: "browserFlightRecorderExported",
  taskId,
  recordedAtMs,
  identity: { attemptId, taskId, bytes: 1024, sha256: hash("f"), gapCount: evidenceComplete ? 0 : 2, sanitizerLossCount: evidenceComplete ? 0 : 1, evidenceComplete },
});

check(selectBrowserTeachSource({ activeTaskId: null, rows: [], recordedAttempt: null, loading: false, recording: false, error: null }).kind === "noTask", "declares the no-current-task entry state");
check(selectBrowserTeachSource({ activeTaskId: "task-1", rows: [], recordedAttempt: null, loading: false, recording: true, error: null }).kind === "recording", "declares the recording entry state");
check(selectBrowserTeachSource({ activeTaskId: "task-1", rows: [], recordedAttempt: null, loading: false, recording: false, error: null }).kind === "noAttempt", "declares the no-attempt entry state");
check(selectBrowserTeachSource({ activeTaskId: "task-1", rows: [attemptRow("attempt-gapped", "task-1", 20, false)], recordedAttempt: null, loading: false, recording: false, error: null }).kind === "evidenceGapped", "declares evidence-gapped source state");
const source = selectBrowserTeachSource({ activeTaskId: "task-1", rows: [attemptRow("attempt-other", "task-2", 40, true), attemptRow("attempt-complete", "task-1", 30, true)], recordedAttempt: null, loading: false, recording: false, error: null });
check(source.kind === "ready" && source.candidate.attemptId === "attempt-complete", "selects only a complete attempt owned by the active task");
const completedSource = selectBrowserTeachSource({ activeTaskId: null, rows: [attemptRow("attempt-older-complete", "task-1", 30, true), attemptRow("attempt-newer-gapped", "task-2", 40, false), attemptRow("attempt-newest-complete", "task-3", 50, true)], recordedAttempt: null, loading: false, recording: false, error: null });
check(completedSource.kind === "ready" && completedSource.candidate.attemptId === "attempt-newest-complete" && completedSource.candidate.taskId === "task-3", "selects the most recent complete attempt after its task has completed");
const completedGappedSource = selectBrowserTeachSource({ activeTaskId: null, rows: [attemptRow("attempt-newest-gapped", "task-2", 40, false), attemptRow("attempt-older-gapped", "task-1", 30, false)], recordedAttempt: null, loading: false, recording: false, error: null });
check(completedGappedSource.kind === "evidenceGapped" && completedGappedSource.candidate.attemptId === "attempt-newest-gapped", "surfaces the most recent gapped attempt when no complete completed-task attempt exists");
check(browserTeachErrorMessage("native Teach rejected the source", "fallback") === "native Teach rejected the source", "preserves string rejections returned by Tauri");
check(browserTeachErrorMessage({ message: "object message" }, "fallback") === "object message", "preserves bounded object error messages");
check(browserTeachErrorMessage("x".repeat(400), "fallback").length === 280, "bounds native error text before rendering it");

const panel = readFileSync(new URL("../src/browser/components/BrowserEvidencePanel.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/browser/components/BrowserTeachReview.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/browser/hooks/useBrowserTeach.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/browser/api.ts", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../src/browser/browserTeach.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/browser/browserEvidence.css", import.meta.url), "utf8");
const teachApi = api.slice(api.indexOf("prepareBrowserTeachDraftForOperator"), api.indexOf("syncBrowserEngine"));

check(panel.includes('data-debug-id="shellx-browser-evidence-teach-workflow"') && panel.includes("selectBrowserTeachSource"), "places Teach workflow beside existing Flight Recorder controls and gates it on an exact complete attempt");
check(panel.includes("const teachTaskId") && panel.includes("teachSource.candidate.taskId") && panel.includes("<BrowserDeveloperInspection activeTaskId={activeTaskId}"), "binds Teach to a completed attempt's task while keeping Developer Inspection on the live task");
check(component.includes('data-debug-id="shellx-browser-teach-save-draft"') && component.includes('data-debug-id="shellx-browser-teach-rehearse"') && component.includes('data-debug-id="shellx-browser-teach-approve-recipe"') && component.includes('data-debug-id="shellx-browser-teach-create-task"'), "provides stable selectors for Save, dry-run Rehearse, explicit approval, and the reviewed Task draft handoff");
check(component.includes('data-debug-id="shellx-browser-teach-redaction"') && component.includes('data-debug-id="shellx-browser-teach-issues"') && component.includes('data-debug-id="shellx-browser-teach-values"'), "renders compact source/redaction review plus actionable issue and named-value editors");
check(component.includes("toggleAmbiguityResolution") && component.includes("updateVaultBinding") && component.includes("updateValue"), "lets the operator resolve ambiguity, replace sanitized literals, and select only a Vault key identity");
check(component.includes("resolvableIssueIds") && component.includes('data-teach-issue-kind={resolvable ? "resolvable" : "source-loss"}') && component.includes("cannot be acknowledged away"), "renders source loss as permanently blocking instead of a resolvable checkbox");
check(component.includes("Resolved blocker") && component.includes("const resolvable") && component.includes("const resolved") && css.includes(".shellx-browser-teach-issues > label.resolved"), "changes a resolved ambiguity from blocker warning semantics to a resolved state without relaxing source loss");
check(component.includes('className="shellx-browser-teach-values"') && !component.includes("<table") && css.includes(".shellx-browser-teach-value-row") && css.includes("appearance: none") && !css.includes(".shellx-browser-teach-table-wrap"), "uses stacked, styled value and Vault editor rows without a horizontal table scroll");
check(component.includes("navigator.clipboard.writeText") && component.includes("approvalCorrelation") && component.includes("rehearsalCorrelation") && component.includes("shellx-browser-teach-copy-approval-receipt") && component.includes("shellx-browser-teach-copy-rehearsal-receipt"), "offers privacy-safe titled receipt correlation that only reports copy success after clipboard write");
check(!component.includes("targetRef") && !component.includes("recipeStep") && !component.includes(".path"), "does not render raw source target references, recipe projections, or private paths");
check(hook.includes("draftId: draft.draft.draftId") && hook.includes("expectedRevisionId") && hook.includes("expectedRevisionSha256") && hook.includes("valueEdits") && hook.includes("vaultBindings") && hook.includes("ambiguityResolutions"), "sends the exact T1 compare-and-swap revision request without invented task or bundle fields");
check(hook.includes("recipeId: approval.recipeId") && hook.includes("sha256: approval.recipeSha256") && !hook.includes("recipePath"), "sends only exact recipe identity and SHA-256 to native rehearsal");
check(hook.includes("rehearsalReceiptId: rehearsal.receipt.receiptId") && hook.includes("rehearsal.stepsSkipped !== 0") && hook.includes("openTaskDraftFromBrowserTeach"), "requires the exact zero-skip rehearsal and an acknowledged main-workspace handoff before claiming the Task draft opened");
check(teachApi.includes('invoke<unknown>("shellx_browser_operator_prepare_teach_draft"') && teachApi.includes('invoke<unknown>("shellx_browser_operator_revise_teach_draft"') && teachApi.includes('invoke<unknown>("shellx_browser_operator_rehearse_teach_recipe"') && teachApi.includes('invoke<unknown>("shellx_browser_operator_approve_teach_draft"') && teachApi.includes('invoke<unknown>("shellx_browser_operator_prepare_teach_task_handoff"'), "uses the exact Tauri-only Teach and reviewed Task handoff commands");
check(!teachApi.includes("apiPostJson") && !teachApi.includes("/browser/teach") && !teachApi.includes("recipePath"), "does not add HTTP approval, apply, Teach mutation routes, or a renderer recipe path");
check(adapter.includes("redactionReceipt") && adapter.includes("currentRevisionId") && adapter.includes("approvalId") && adapter.includes("stepsApplied !== 0"), "normalizes the exact T1 receipt, current-revision, approval, and zero-apply rehearsal contracts");
check(css.includes(".shellx-browser-teach-section") && css.includes(".shellx-browser-teach-issues") && css.includes(":focus-visible") && css.includes("@media (max-width: 620px)") && css.includes("min-width: 0"), "keeps Teach in the Evidence visual language with visible focus and constrained-width layout");

console.log("ShellX Browser Teach review UI checks passed");
