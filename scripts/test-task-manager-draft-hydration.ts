import assert from "node:assert/strict";
import type { ConnectionPreset } from "../src/components/ConnectionPicker";
import type { TaskManagerData, TaskManagerDraft } from "../src/lib/task-manager-contract";
import { createTaskManagerController } from "../src/lib/task-manager-controller";
import {
  taskManagerDraftFromSummary,
  taskManagerDraftHandoffKey,
  taskManagerIncomingDraft,
} from "../src/lib/task-manager-draft-hydration";
import type { TaskStoreRecord, TaskStoreStateProjection } from "../src/lib/task-manager-tauri-adapter";

const preset: ConnectionPreset = {
  id: "remote-windows",
  label: "Remote Windows",
  transport: { kind: "ssh", host: "user@windows-host.example", remoteGrokPath: "grok", remoteRuntime: "windows" },
  createdMs: 1,
  lastUsedMs: 1,
};
const emptyDraft: TaskManagerDraft = {
  originRequestId: "empty",
  originRevision: 1,
  name: "",
  instruction: "",
  environmentKey: "",
  schedule: { trigger: { kind: "manual" }, timezone: "UTC", missedRunPolicy: "skip", maxRunSeconds: 600, notificationPolicy: "attentionOnly" },
  enabled: false,
  candidates: [],
};
const firstRecord = recordFor({
  revisionId: "task-1:r1",
  revisionHash: "b".repeat(64),
  instruction: "Inspect the current release checklist.",
  providerId: "codex-cli",
  toolExposureIds: ["nativeFirst"],
});
const secondRecord = recordFor({
  revisionId: "task-1:r2",
  revisionHash: "c".repeat(64),
  instruction: "Inspect the revised release checklist.",
  providerId: "grok",
  toolExposureIds: ["readOnly"],
});
const firstGet = deferred<TaskStoreRecord>();
const secondGet = deferred<TaskStoreRecord>();
const getResponses = [firstGet, secondGet];
const getStateResponses = [stateFor(firstRecord), stateFor(secondRecord)];
let latestData: TaskManagerData | undefined;

const controller = createTaskManagerController({
  invoke: async <T,>(command: string): Promise<T> => {
    if (command === "connections_list") return [preset] as T;
    if (command === "tasks_list") return [firstRecord] as T;
    if (command === "tasks_list_states") return [stateFor(firstRecord)] as T;
    if (command === "tasks_get") return getResponses.shift()!.promise as T;
    if (command === "tasks_get_state") return getStateResponses.shift()! as T;
    if (command === "tasks_list_receipts") return [] as T;
    throw new Error(`unexpected command ${command}`);
  },
  onData: (data) => { latestData = data; },
});

await controller.load({
  localPreset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  activeConnectionId: "remote-windows",
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
  projectLabel: "ShellX",
});
const summary = latestData!.definitions[0]!;
const summaryDraft = taskManagerDraftFromSummary(summary, emptyDraft.schedule);

const initialSelection = controller.selectDefinition(summary.id);
assert.equal(latestData!.selectedDefinitionId, summary.id);
assert.equal(latestData!.selectedDefinition, undefined, "the exact tasks_get response is intentionally pending");
const pendingDraft = taskManagerIncomingDraft({
  mode: "edit",
  currentDraft: summaryDraft,
  emptyDraft,
  selectedDefinitionId: latestData!.selectedDefinitionId,
  selectedDefinition: latestData!.selectedDefinition,
});
assert.equal(pendingDraft, summaryDraft, "row selection must retain its local summary draft while tasks_get is pending");
assert.equal(pendingDraft.name, "Release checklist");
assert.equal(pendingDraft.instruction, "Inspect the current release checklist.");
assert.equal(pendingDraft.environmentKey, "remote-windows");

firstGet.resolve(firstRecord);
await initialSelection;
const firstDetail = latestData!.selectedDefinition!;
const firstKey = taskManagerDraftHandoffKey("edit", undefined, latestData!.selectedDefinitionId, firstDetail);
const hydratedDraft = taskManagerIncomingDraft({
  mode: "edit",
  currentDraft: pendingDraft,
  emptyDraft,
  selectedDefinitionId: latestData!.selectedDefinitionId,
  selectedDefinition: firstDetail,
});
assert.equal(hydratedDraft.revisionId, "task-1:r1");
assert.equal(hydratedDraft.revisionHash, "b".repeat(64));
assert.deepEqual(hydratedDraft.candidates, [{ providerId: "codex-cli", modelMode: "providerDefault", order: 1 }]);
assert.deepEqual(hydratedDraft.context?.attachmentRefs, [{ attachmentId: "asset-42" }]);
assert.deepEqual(hydratedDraft.context?.toolExposureIds, ["nativeFirst"]);

const revisionRefresh = controller.selectDefinition(summary.id);
const refreshDraft = taskManagerIncomingDraft({
  mode: "edit",
  currentDraft: hydratedDraft,
  emptyDraft,
  selectedDefinitionId: latestData!.selectedDefinitionId,
  selectedDefinition: latestData!.selectedDefinition,
});
assert.equal(refreshDraft, hydratedDraft, "a revision refresh must retain the exact current draft until its replacement arrives");
secondGet.resolve(secondRecord);
await revisionRefresh;
const secondDetail = latestData!.selectedDefinition!;
const secondKey = taskManagerDraftHandoffKey("edit", undefined, latestData!.selectedDefinitionId, secondDetail);
const revisedDraft = taskManagerIncomingDraft({
  mode: "edit",
  currentDraft: hydratedDraft,
  emptyDraft,
  selectedDefinitionId: latestData!.selectedDefinitionId,
  selectedDefinition: secondDetail,
});
assert.notEqual(secondKey, firstKey, "an exact revision hash must change the component handoff key");
assert.equal(revisedDraft.revisionId, "task-1:r2");
assert.equal(revisedDraft.revisionHash, "c".repeat(64));
assert.equal(revisedDraft.instruction, "Inspect the revised release checklist.");
assert.deepEqual(revisedDraft.candidates, [{ providerId: "grok", modelMode: "providerDefault", order: 1 }]);
assert.deepEqual(revisedDraft.context?.toolExposureIds, ["readOnly"]);

console.log("Task Manager draft hydration passed: pending rows retain summary fields, exact details hydrate CAS/context, and newer hashes replace the draft.");

function recordFor(input: {
  revisionId: string;
  revisionHash: string;
  instruction: string;
  providerId: string;
  toolExposureIds: string[];
}): TaskStoreRecord {
  return {
    definition: {
      taskId: "task-1",
      name: "Release checklist",
      enabled: true,
      paused: false,
      currentRevisionId: input.revisionId,
      currentRevisionNumber: input.revisionId.endsWith("r2") ? 2 : 1,
      currentRevisionHash: input.revisionHash,
      retentionPolicy: { maxReceipts: 128 },
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    revision: {
      revisionId: input.revisionId,
      taskId: "task-1",
      revisionNumber: input.revisionId.endsWith("r2") ? 2 : 1,
      canonicalSha256: input.revisionHash,
      createdAtMs: 1,
      name: "Release checklist",
      instruction: input.instruction,
      environment: {
        connectionId: "remote-windows",
        snapshotId: `sha256:${"a".repeat(64)}`,
        targetKey: "ssh:windows:user@windows-host.example:22",
        canonicalCwd: "C:\\Users\\User\\shellx",
        projectId: "shellx",
      },
      candidates: [{
        order: 1,
        providerId: input.providerId,
        model: { mode: "providerDefault" },
        capabilityRequirements: [],
        optionRefs: [],
      }],
      executionPolicy: {
        permissionMode: "default",
        autonomyMode: "default",
        toolExposureIds: input.toolExposureIds,
      },
      attachmentRefs: [{ attachmentId: "asset-42" }],
      vaultRequirements: [],
      trigger: { kind: "manual" },
      timezone: "Europe/Riga",
      missedRunPolicy: "skip",
      concurrencyPolicy: { maxActiveRuns: 1 },
      timeoutPolicy: { maxRunSeconds: 600 },
      retryPolicy: { maxAttempts: 1, idempotentObservationOnly: false },
      notificationPolicy: "attentionOnly",
      retentionPolicy: { maxReceipts: 128 },
      origin: { sessionId: "session-1", tabId: "tab-1" },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve: (value) => resolve!(value) };
}

function stateFor(record: TaskStoreRecord): TaskStoreStateProjection {
  return {
    schemaVersion: "shellx.task-state-projection.v1",
    taskId: record.definition.taskId,
    name: record.definition.name,
    currentRevisionId: record.definition.currentRevisionId,
    currentRevisionNumber: record.definition.currentRevisionNumber,
    savedEnvironment: {
      snapshotId: record.revision.environment.snapshotId,
      targetKey: record.revision.environment.targetKey,
    },
    state: record.definition.paused ? "paused" : "scheduled",
    attentionCount: 0,
    attentionCountCapped: false,
    attentionItemsTruncated: false,
    attentionResolution: "explicitFutureReceiptOrActionRequired",
    attention: [],
    runHistory: [],
  };
}
