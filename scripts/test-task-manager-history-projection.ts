import assert from "node:assert/strict";
import type { TaskRunHistoryEntry } from "../src/lib/task-manager-contract";
import {
  MAX_TASK_TIMELINE_ENTRIES,
  taskAttentionCount,
  taskAttentionPresentation,
  taskEnvironmentReceiptPresentation,
  taskResultEvidencePresentation,
  taskTraceEvidencePresentation,
  taskRunStatePresentation,
  taskTimelineForDisplay,
  taskTimelinePresentation,
} from "../src/lib/task-manager-history-projection";
import { TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS } from "../src/lib/task-manager-fixtures";

const definition = TASK_MANAGER_FIXTURE_DATA.selectedDefinition!;
const attention = taskAttentionPresentation(definition);
assert.deepEqual(attention, {
  count: 2,
  title: "Outcome unknown",
  detail: "Review this occurrence before starting any replacement work.",
});
assert.equal(taskAttentionCount([definition, { ...definition, state: "recent", attention: undefined }]), 2);
assert.equal(taskAttentionCount([{ ...definition, state: "needsAttention", attention: undefined }]), 1, "old rows retain one safe generic attention indicator");

const running = definition.runHistory.find((run) => run.id === "run-fixture-running")!;
const timeline = taskTimelineForDisplay(running);
assert.deepEqual(timeline.map((entry) => entry.receiptId), [
  "receipt-running-scheduled",
  "receipt-running-claim",
  "receipt-running-route-1",
  "receipt-running-route-2",
  "receipt-running-start",
]);
assert.deepEqual(taskEnvironmentReceiptPresentation(running).map((entry) => entry.kind), ["savedDefinitionSnapshot", "freshExecutionScan"]);
assert.equal(taskEnvironmentReceiptPresentation(running)[0]?.label, "Saved definition environment");
assert.equal(taskEnvironmentReceiptPresentation(running)[1]?.label, "Fresh execution scan");

const fallback = taskTimelinePresentation(timeline[2]!);
assert.equal(fallback.label, "Choice 1 · Grok skipped before work");
assert.equal(fallback.detail, "This agent could not start before task work began.");
assert.equal(taskTimelinePresentation(timeline[4]!).label, "Task work started");
for (const [providerLifecycle, label] of [
  ["accepted", "Agent accepted task"],
  ["running", "Agent is running"],
  ["firstContent", "First response received"],
] as const) {
  assert.equal(taskTimelinePresentation({
    receiptId: `receipt-${providerLifecycle}`,
    occurredAtMs: TASK_MANAGER_FIXTURE_NOW_MS,
    kind: "committedStart",
    providerLifecycle,
  }).label, label);
}

const completed = definition.runHistory.find((run) => run.id === "run-fixture-completed")!;
assert.deepEqual(taskResultEvidencePresentation(completed), {
  label: "Browser result evidence recorded",
  detail: "1 Flight Recorder bundle and 1 evaluation bound to this run.",
  occurredAtMs: TASK_MANAGER_FIXTURE_NOW_MS - 39_000,
});
const completedTimeline = taskTimelineForDisplay(completed);
assert.equal(taskTimelinePresentation(completedTimeline.find((entry) => entry.kind === "traceEvidence")!).label, "Conversation evidence recorded");
assert.equal(taskTimelinePresentation(completedTimeline.find((entry) => entry.kind === "resultEvidence")!).label, "Result evidence recorded");
assert.equal(taskResultEvidencePresentation({ resultEvidence: {
  ...completed.resultEvidence!,
  state: "noBrowserActivity",
  browserTaskCount: 0,
  exportedBrowserTaskCount: 0,
  recorderCount: 0,
  evaluationCount: 0,
  identities: [],
} })?.detail, "No Task-owned Browser activity was recorded for this run.");
assert.deepEqual(taskTraceEvidencePresentation({ traceEvidence: {
  state: "complete",
  archiveSha256: "a".repeat(64),
  archiveBytes: 512,
  recordCount: 7,
  providerEventCount: 3,
  droppedEventCount: 0,
  terminalMarkerPresent: true,
  recoveredAfterRestart: false,
  recordedAtMs: TASK_MANAGER_FIXTURE_NOW_MS,
} }), {
  label: "Task conversation recorded",
  detail: "3 provider events bound to this exact run.",
  occurredAtMs: TASK_MANAGER_FIXTURE_NOW_MS,
});
assert.match(taskTraceEvidencePresentation({ traceEvidence: {
  state: "incomplete",
  archiveBytes: 256,
  recordCount: 4,
  providerEventCount: 0,
  droppedEventCount: 0,
  terminalMarkerPresent: false,
  recoveredAfterRestart: true,
  recordedAtMs: TASK_MANAGER_FIXTURE_NOW_MS,
} })!.detail, /recovered after restart/);

for (const [state, label] of [
  ["pending", "Pending"],
  ["running", "Running"],
  ["completed", "Completed"],
  ["outcomeUnknown", "Outcome unknown"],
  ["missedNeedsAttention", "Missed · needs attention"],
] as const) assert.equal(taskRunStatePresentation(state).label, label);

const ordered: TaskRunHistoryEntry = {
  id: "run-bounded",
  state: "pending",
  timeline: Array.from({ length: MAX_TASK_TIMELINE_ENTRIES + 3 }, (_, index) => ({
    receiptId: `receipt-${index}`,
    occurredAtMs: TASK_MANAGER_FIXTURE_NOW_MS + MAX_TASK_TIMELINE_ENTRIES + 3 - index,
    kind: "occurrenceScheduled" as const,
  })),
};
const bounded = taskTimelineForDisplay(ordered);
assert.equal(bounded.length, MAX_TASK_TIMELINE_ENTRIES);
assert.deepEqual(bounded.map((entry) => entry.receiptId), Array.from({ length: MAX_TASK_TIMELINE_ENTRIES }, (_, index) => `receipt-${MAX_TASK_TIMELINE_ENTRIES - index - 1}`));

const hostileLegacy: TaskRunHistoryEntry = {
  id: "run-redacted",
  state: "failed",
  summary: "provider output C:\\Users\\Martin\\secret-token",
  disabledReason: "authentication bearer secret",
  timeline: [{ receiptId: "receipt-safe", occurredAtMs: TASK_MANAGER_FIXTURE_NOW_MS, kind: "providerDecision", provider: { providerId: "unknown-provider", candidateOrder: 1, verdict: "rejectedPreEffect" } }],
};
const safePresentation = taskTimelinePresentation(taskTimelineForDisplay(hostileLegacy)[0]!);
assert.equal(safePresentation.label, "Choice 1 · Saved agent skipped before work");
assert.equal(`${safePresentation.label} ${safePresentation.detail}`.includes("secret-token"), false);
assert.equal(`${safePresentation.label} ${safePresentation.detail}`.includes("C:\\Users"), false);
assert.equal(`${safePresentation.label} ${safePresentation.detail}`.includes("authentication"), false);

console.log("Task Manager history projection passed: typed attention counts, compact state labels, bounded ordered receipt timelines, explicit saved-vs-fresh environment evidence, path-free Browser result evidence, provider fallback receipts, and no legacy diagnostic rendering.");
