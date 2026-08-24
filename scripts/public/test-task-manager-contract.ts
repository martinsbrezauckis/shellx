import assert from "node:assert/strict";
import type { TaskSchedule } from "../../src/lib/task-manager-contract";
import {
  createTaskManagerDraft,
  isTaskProviderCatalogueFresh,
  normalizeTaskSchedule,
  normalizeTaskCandidates,
  providerEditorDisabledReason,
  taskProviderSelectionDisabledReason,
  taskProvidersForDisplay,
  taskReadyProviderRouteDisabledReason,
  taskDeviceTimezone,
  taskSaveDisabledReason,
  taskScheduleSummary,
  taskScheduleValidationReason,
} from "../../src/lib/task-manager-contract";
import {
  TASK_MANAGER_FIXTURE_CATALOGUE,
  TASK_MANAGER_FIXTURE_DATA,
  TASK_MANAGER_FIXTURE_DRAFT,
  TASK_MANAGER_FIXTURE_NOW_MS,
} from "../../src/lib/task-manager-fixtures";

assert.equal(isTaskProviderCatalogueFresh(TASK_MANAGER_FIXTURE_CATALOGUE, "local", TASK_MANAGER_FIXTURE_NOW_MS), true);
assert.equal(isTaskProviderCatalogueFresh(TASK_MANAGER_FIXTURE_CATALOGUE, "remote-windows", TASK_MANAGER_FIXTURE_NOW_MS), false);
assert.equal(isTaskProviderCatalogueFresh(TASK_MANAGER_FIXTURE_CATALOGUE, "local", TASK_MANAGER_FIXTURE_CATALOGUE.freshUntilMs), false);
assert.equal(isTaskProviderCatalogueFresh({ ...TASK_MANAGER_FIXTURE_CATALOGUE, snapshotId: "not-a-sha256" }, "local", TASK_MANAGER_FIXTURE_NOW_MS), false);
assert.equal(isTaskProviderCatalogueFresh({ ...TASK_MANAGER_FIXTURE_CATALOGUE, snapshotId: "8e1a0af5b127e67dbf23547b7c5d3dc541096ef1c19559e2ce40fd667dc5cc90" }, "local", TASK_MANAGER_FIXTURE_NOW_MS), false);

assert.deepEqual(normalizeTaskCandidates([
  { providerId: "grok", modelMode: "providerDefault", order: 8 },
  { providerId: "grok", modelMode: "verifiedModel", modelId: "invented-model", order: 9 },
  { providerId: "codex-cli", modelMode: "verifiedModel", order: 3 },
]), [
  { providerId: "grok", modelMode: "providerDefault", order: 1 },
  { providerId: "codex-cli", modelMode: "verifiedModel", order: 2 },
]);

assert.deepEqual(
  taskProvidersForDisplay(TASK_MANAGER_FIXTURE_CATALOGUE.providers, [
    { providerId: "codex-cli", modelMode: "providerDefault", order: 1 },
    { providerId: "grok", modelMode: "providerDefault", order: 2 },
  ]).map((provider) => provider.providerId),
  ["codex-cli", "grok"],
  "selected agents must render in their numbered fallback order rather than catalogue order",
);

assert.equal(providerEditorDisabledReason(
  { environmentKey: "" },
  TASK_MANAGER_FIXTURE_DATA,
  TASK_MANAGER_FIXTURE_NOW_MS,
), "Select an environment before choosing an agent.");

assert.equal(providerEditorDisabledReason(
  { environmentKey: "remote-windows" },
  TASK_MANAGER_FIXTURE_DATA,
  TASK_MANAGER_FIXTURE_NOW_MS,
), "These availability results belong to This computer; recheck the selected environment.");

const staleData = {
  ...TASK_MANAGER_FIXTURE_DATA,
  providerCatalogue: { ...TASK_MANAGER_FIXTURE_CATALOGUE, freshUntilMs: TASK_MANAGER_FIXTURE_NOW_MS - 1 },
};
assert.equal(providerEditorDisabledReason(TASK_MANAGER_FIXTURE_DRAFT, staleData, TASK_MANAGER_FIXTURE_NOW_MS), "Agent availability is out of date; recheck before changing the order.");

assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, candidates: [] }, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), "Choose at least one agent before saving.");
assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, taskId: "task-fixture-001", revisionId: "revision-fixture-001" }, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), "The selected task revision has no hash; reload it before saving.");
assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, taskId: "task-fixture-001", revisionId: "revision-fixture-001", revisionHash: "not-a-sha256" }, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), "The selected task revision hash is invalid; reload it before saving.");
assert.equal(taskSaveDisabledReason({
  ...TASK_MANAGER_FIXTURE_DRAFT,
  taskId: TASK_MANAGER_FIXTURE_DATA.selectedDefinition!.id,
  revisionId: TASK_MANAGER_FIXTURE_DATA.selectedDefinition!.revisionId,
  revisionHash: TASK_MANAGER_FIXTURE_DATA.selectedDefinition!.revisionHash,
}, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), undefined, "a canonical Rust Task revision hash remains editable");
assert.equal(taskSaveDisabledReason({
  ...TASK_MANAGER_FIXTURE_DRAFT,
  taskId: "task-fixture-001",
  revisionId: "revision-fixture-001",
  revisionHash: `sha256:${"a".repeat(64)}`,
}, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), "The selected task revision hash is invalid; reload it before saving.");
assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, enabled: false }, staleData, TASK_MANAGER_FIXTURE_NOW_MS), undefined, "paused drafts retain their reviewed route while Save performs a fresh preflight");
assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, enabled: true }, staleData, TASK_MANAGER_FIXTURE_NOW_MS), "Agent availability is out of date; recheck before changing the order.");
assert.equal(taskSaveDisabledReason({ ...TASK_MANAGER_FIXTURE_DRAFT, enabled: true }, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), undefined);

const pausedUnavailableDraft = {
  ...TASK_MANAGER_FIXTURE_DRAFT,
  enabled: false,
  candidates: [{ providerId: "codex-cli", modelMode: "providerDefault" as const, order: 1 }],
};
assert.equal(
  taskProviderSelectionDisabledReason(pausedUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, "codex-cli", false, TASK_MANAGER_FIXTURE_NOW_MS),
  undefined,
  "a fresh exact catalogue lets a paused draft choose an unavailable provider for later",
);
assert.equal(
  taskProviderSelectionDisabledReason(pausedUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, "codex-cli", true, TASK_MANAGER_FIXTURE_NOW_MS),
  undefined,
  "a paused draft may also deselect an unavailable provider",
);
assert.equal(taskSaveDisabledReason(pausedUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS), undefined);
assert.equal(
  taskReadyProviderRouteDisabledReason(pausedUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS),
  "Run now requires at least one currently ready agent.",
);
const enabledUnavailableDraft = { ...pausedUnavailableDraft, enabled: true };
assert.equal(
  taskProviderSelectionDisabledReason(enabledUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, "codex-cli", false, TASK_MANAGER_FIXTURE_NOW_MS),
  "Codex CLI is not currently ready. Pause the task to keep this route for later.",
);
assert.equal(
  taskSaveDisabledReason(enabledUnavailableDraft, TASK_MANAGER_FIXTURE_DATA, TASK_MANAGER_FIXTURE_NOW_MS),
  "Enable requires at least one currently ready agent.",
);
assert.equal(
  taskProviderSelectionDisabledReason(pausedUnavailableDraft, staleData, "codex-cli", false, TASK_MANAGER_FIXTURE_NOW_MS),
  "Agent availability is out of date; recheck before changing the order.",
);

const resetDraft = createTaskManagerDraft(TASK_MANAGER_FIXTURE_DRAFT, {
  originRequestId: "composer-request-fixture-002",
  originRevision: 2,
  candidates: [{ providerId: "grok", modelMode: "providerDefault", order: 4 }],
});
assert.equal(resetDraft.originRequestId, "composer-request-fixture-002");
assert.equal(resetDraft.originRevision, 2);
assert.deepEqual(resetDraft.candidates, [{ providerId: "grok", modelMode: "providerDefault", order: 1 }]);

const baseSchedule = TASK_MANAGER_FIXTURE_DRAFT.schedule;
assert.match(taskDeviceTimezone(), /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/);
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "manual" } }).trigger, { kind: "manual" });
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "once", atMs: TASK_MANAGER_FIXTURE_NOW_MS } }).trigger, { kind: "once", atMs: TASK_MANAGER_FIXTURE_NOW_MS });
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "daily", at: { hour: 9, minute: 0 } } }).trigger, { kind: "daily", at: { hour: 9, minute: 0 } });
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "weekdays", at: { hour: 9, minute: 0 } } }).trigger, { kind: "weekdays", at: { hour: 9, minute: 0 } });
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "weekly", weekdays: ["friday", "monday"], at: { hour: 9, minute: 0 } } }).trigger, { kind: "weekly", weekdays: ["monday", "friday"], at: { hour: 9, minute: 0 } });
assert.deepEqual(normalizeTaskSchedule({ ...baseSchedule, trigger: { kind: "monthly", day: 31, at: { hour: 9, minute: 0 } } }).trigger, { kind: "monthly", day: 31, at: { hour: 9, minute: 0 } });
assert.match(taskScheduleSummary({ ...baseSchedule, trigger: { kind: "once", atMs: TASK_MANAGER_FIXTURE_NOW_MS + 60_000 } }), /^Once on /);
assert.doesNotMatch(taskScheduleSummary({ ...baseSchedule, trigger: { kind: "once", atMs: TASK_MANAGER_FIXTURE_NOW_MS + 60_000 } }), /UTC|Europe\/|T\d{2}:/);
assert.equal(taskScheduleValidationReason({ ...baseSchedule, trigger: { kind: "once", atMs: TASK_MANAGER_FIXTURE_NOW_MS - 1 } }, TASK_MANAGER_FIXTURE_NOW_MS), "Choose a future date and time for a one-time task.");
assert.match(taskScheduleValidationReason({ ...baseSchedule, timezone: "Invalid/Timezone" }, TASK_MANAGER_FIXTURE_NOW_MS) ?? "", /supported by this computer/i);

const invalidSchedules: Array<[TaskSchedule, RegExp]> = [
  [{ ...baseSchedule, trigger: { kind: "once", atMs: 0 } }, /once schedules/i],
  [{ ...baseSchedule, trigger: { kind: "daily", at: { hour: 24, minute: 0 } } }, /local time/i],
  [{ ...baseSchedule, trigger: { kind: "weekly", weekdays: [], at: { hour: 9, minute: 0 } } }, /weekday/i],
  [{ ...baseSchedule, trigger: { kind: "weekly", weekdays: ["monday", "monday"], at: { hour: 9, minute: 0 } } }, /unique/i],
  [{ ...baseSchedule, trigger: { kind: "monthly", day: 32, at: { hour: 9, minute: 0 } } }, /1 through 31/i],
  [{ ...baseSchedule, timezone: "" }, /timezone/i],
  [{ ...baseSchedule, maxRunSeconds: 0 }, /duration/i],
];
for (const [schedule, pattern] of invalidSchedules) {
  assert.throws(() => normalizeTaskSchedule(schedule), pattern);
}

console.log("Task Manager contract passed: snapshot freshness, paused unavailable route retention, ready-route enable/run guards, route normalization, structured schedule normalization/refusal, and explicit composer draft identity.");
