import { readFileSync } from "node:fs";

import {
  normalizeBrowserEvidenceSummary,
  normalizeBrowserFlightRecorderResult,
} from "../src/browser/browserEvidence";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function evidenceResponse(recent: unknown[]): unknown {
  return {
    ok: true,
    callerScoped: false,
    durableRecovered: 1,
    durableScanTruncated: false,
    durableScanFailed: false,
    durableSkipped: 0,
    schemas: {
      attempt: "sx.flightRecorder.v1",
      evaluation: "sx.evaluation.v1",
      ratingPolicy: "sx.evaluation-rating.v1",
    },
    recent,
  };
}

const attempt = {
  receiptId: "receipt-attempt",
  kind: "browserFlightRecorderExported",
  taskId: "task-1",
  summary: "must not become display data",
  t: 100,
  evidence: {
    attemptId: "attempt-1",
    taskId: "task-1",
    path: "/private/never-render-this.json",
    source: "operator",
    bytes: 4096,
    sha256: "a".repeat(64),
    events: 12,
    receipts: 8,
    droppedEvents: 1,
    droppedReceipts: 2,
    retentionDroppedEvents: 3,
    retentionDroppedReceipts: 1,
    sanitizerLossCount: 2,
    gapCount: 4,
    evidenceComplete: false,
  },
};
const evaluation = {
  receiptId: "receipt-evaluation",
  kind: "browserEvaluationReportWritten",
  taskId: "task-1",
  t: 200,
  evidence: {
    reportId: "report-1",
    taskId: "task-1",
    path: "C:\\private\\never-render-this.json",
    bytes: 2048,
    sha256: "b".repeat(64),
    baselineAttempts: 1,
    candidateAttempts: 1,
    safetyViolationDelta: -1,
    improvementScore: 0.25,
    improvementRating: "improved",
    evidenceComplete: true,
  },
};

console.log("\n=== ShellX Browser evidence UI ===");
const normalized = normalizeBrowserEvidenceSummary(evidenceResponse([evaluation, attempt]));
assert(normalized.rows.length === 2, "normalizes bounded attempt and evaluation receipts");
assert(normalized.rows[0]?.identity.reportId === "report-1", "preserves exact evaluation identity");
assert(normalized.rows[1]?.identity.attemptId === "attempt-1", "preserves exact attempt identity");
assert(normalized.rows[1]?.identity.gapCount === 4, "preserves recorder gap accounting");
assert(normalized.rows[1]?.identity.sanitizerLossCount === 2, "preserves sanitizer-loss accounting");
assert(normalized.rows[1]?.identity.evidenceComplete === false, "preserves incomplete recorder status");
assert(normalized.rows[0]?.identity.evidenceComplete === true, "preserves evidence completeness");
assert(normalized.rows[0]?.identity.safetyViolationDelta === -1, "preserves signed safety delta");
assert(normalized.durableRecovered === 1, "reports identities restored from durable storage");
assert(
  normalized.durableScanFailed === false
    && normalized.durableScanTruncated === false
    && normalized.durableSkipped === 0,
  "reports durable index health",
);
assert(!("path" in normalized.rows[0]!.identity), "drops private artifact paths at the UI parser boundary");
assert(!("source" in normalized.rows[1]!.identity), "drops non-display receipt metadata");

const recorded = normalizeBrowserFlightRecorderResult({
  attemptId: "attempt-current",
  taskId: "task-1",
  path: "/private/never-render-this.json",
  bytes: 512,
  sha256: "c".repeat(64),
  events: 4,
  receipts: 3,
  gapCount: 1,
  sanitizerLossCount: 2,
  evidenceComplete: false,
  createdAtMs: 300,
});
assert(recorded.attemptId === "attempt-current" && recorded.gapCount === 1, "validates the manual recorder result identity");
assert(recorded.sanitizerLossCount === 2, "validates the manual recorder sanitizer-loss identity");
assert(!("path" in recorded), "drops the private recorder artifact path from the manual result");

for (const [label, input] of [
  ["unbounded rows", evidenceResponse(Array.from({ length: 21 }, () => attempt))],
  ["unknown receipt kind", evidenceResponse([{ ...attempt, kind: "other" }])],
  ["invalid artifact hash", evidenceResponse([{ ...attempt, evidence: { ...attempt.evidence, sha256: "bad" } }])],
  ["missing attempt identity", evidenceResponse([{ ...attempt, evidence: { ...attempt.evidence, attemptId: undefined } }])],
] as const) {
  let rejected = false;
  try {
    normalizeBrowserEvidenceSummary(input);
  } catch {
    rejected = true;
  }
  assert(rejected, `rejects ${label}`);
}

const sidebar = readFileSync(new URL("../src/browser/components/AgentSidebar.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/browser/components/BrowserEvidencePanel.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/browser/hooks/useBrowserEvidence.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/browser/api.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("../src-tauri/src/debug_api_browser_artifacts.rs", import.meta.url), "utf8");
const rustLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const stateHook = readFileSync(new URL("../src/browser/hooks/useBrowserState.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/browser/browserEvidence.css", import.meta.url), "utf8");

assert(sidebar.includes('data-debug-id="shellx-browser-right-tab-evidence"'), "wires a dedicated Evidence tab");
assert(sidebar.includes('aria-controls="shellx-browser-panel-evidence"'), "links the Evidence tab to its panel");
assert(panel.includes('data-debug-id="shellx-browser-evidence-refresh"'), "wires a real refresh action");
assert(
  panel.includes("data-browser-evidence-manual-refresh-sequence")
    && panel.includes("data-browser-evidence-manual-refresh-completed-at-ms"),
  "publishes a bounded successful manual-refresh receipt",
);
assert(panel.includes('data-debug-id="shellx-browser-evidence-record"'), "wires a current-task recorder action");
assert(panel.includes("activeTaskId") && panel.includes("evidence.recordAttempt(activeTaskId)"), "binds manual recording to the current browser task");
assert(panel.includes("Attempt recorded with evidence gaps"), "reports an incomplete recorder attempt honestly");
assert(panel.includes("evidence.error") && panel.includes("rows.length === 0"), "renders error and empty states");
assert(panel.includes("durableIndexPartial") && panel.includes("restored"), "surfaces durable recovery and partial-index states");
assert(
  panel.includes("evidenceComplete === true") && panel.includes("Incomplete") && panel.includes("Gapped"),
  "labels complete, incomplete, and gapped evidence explicitly",
);
assert(panel.includes("sanitizerLossCount"), "renders explicit sanitizer-loss counts when present");
assert(!panel.includes("identity.path") && !panel.includes("row.summary"), "does not render raw path or receipt summary fields");
assert(hook.includes("loadBrowserEvidenceForOperator(20)"), "loads bounded evidence through operator-only Tauri IPC");
assert(
  hook.includes("setManualRefreshSequence") && hook.includes("setManualRefreshCompletedAtMs"),
  "counts only completed manual evidence refreshes",
);
assert(hook.includes("exportBrowserFlightRecorderForOperator"), "exports through operator-only Tauri IPC");
assert(
  api.includes('invoke<unknown>("shellx_browser_operator_evidence_summary"')
    && api.includes('invoke<unknown>("shellx_browser_operator_export_flight_recorder"'),
  "binds both operator evidence actions to explicit Tauri commands",
);
assert(
  rustLib.includes("shellx_browser_operator_evidence_summary")
    && rustLib.includes("shellx_browser_operator_export_flight_recorder"),
  "registers both operator evidence commands with Tauri",
);
assert(
  router.includes("required_browser_evidence_caller_id(&headers)")
    && router.includes("ShellX MCP caller id is required for Browser evidence routes")
    && !router.includes("registry.export_flight_recorder(body)"),
  "requires agent caller scope instead of granting operator authority on headerless Debug API evidence calls",
);
assert(stateHook.includes('key === "evidence" || key === "flight recorder"'), "debug state can open the Evidence tab");
assert(css.includes(".shellx-browser-evidence-panel") && css.includes(".shellx-browser-evidence-error"), "styles the primary and recovery states");

console.log("ShellX Browser evidence UI checks passed");
