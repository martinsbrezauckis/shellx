import assert from "node:assert/strict";
import type { ConnectionPreset } from "../src/components/ConnectionPicker";
import type { TaskManagerData } from "../src/lib/task-manager-contract";
import type { TaskProviderCatalog } from "../src/lib/task-provider-catalog";
import { createTaskManagerController } from "../src/lib/task-manager-controller";
import {
  createComposerTaskDraft,
  draftToTaskStoreDraft,
  recordToTaskDefinitionSummary,
  taskEnvironmentOption,
  toTaskProviderCatalogue,
  type TaskManagerEnvironment,
  type TaskStoreRecord,
  type TaskStoreStateProjection,
} from "../src/lib/task-manager-tauri-adapter";

const preset: ConnectionPreset = {
  id: "remote-windows",
  label: "Remote Windows",
  transport: { kind: "ssh", host: "user@windows-host.example", remoteGrokPath: "grok", remoteRuntime: "windows" },
  createdMs: 1,
  lastUsedMs: 1,
};

const rawCatalogue: TaskProviderCatalog = {
  schemaVersion: "shellx.task-provider-catalog.v1",
  snapshotId: `sha256:${"a".repeat(64)}`,
  generatedAtMs: 1_786_112_400_000,
  freshUntilMs: 1_786_112_460_000,
  target: { key: "ssh:windows:user@windows-host.example:22", label: "Remote Windows", transport: "ssh", runtime: "windows" },
  providers: [
    {
      providerId: "codex-cli",
      label: "Codex CLI",
      availability: { status: "ready", canRun: true, version: "codex 1.0", detail: "Ready.", checkedAtMs: 1_786_112_400_000 },
      capabilityGuidance: [{ id: "code", label: "Code guidance", level: "guidance", sourceCardIds: ["codex"] }],
      models: [],
      defaultModelMode: "providerDefault",
    },
  ],
};

const catalogue = toTaskProviderCatalogue(rawCatalogue, "remote-windows");
assert.equal(catalogue.environmentKey, "remote-windows", "logical preset identity must not be replaced by the target identity");
assert.equal(catalogue.target.key, "ssh:windows:user@windows-host.example:22");
assert.equal(taskEnvironmentOption({
  key: "local",
  preset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  canonicalCwd: "C:\\Users\\User\\shellx",
}).label, "This computer");

const draft = createComposerTaskDraft({
  requestId: "composer-task-1",
  tabId: "tab-1",
  sessionId: "session-1",
  connectionKey: "remote-windows",
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
  agentSuggestion: "grok",
  permissionMode: "bypassPermissions",
  autonomyMode: "bypassPermissions",
  toolExposureIds: ["nativeFirst"],
  attachmentRefs: [{ attachmentId: "asset-42" }],
  visiblePrompt: "Review the visible unsent release checklist.",
  suggestedName: "Release checklist",
  timezone: "Europe/Riga",
});

assert.deepEqual(draft.candidates, [], "the chat agent may be a suggestion but never becomes a route candidate");
assert.equal(draft.context?.agentSuggestion, "grok");
assert.deepEqual(draft.context?.attachmentRefs, [{ attachmentId: "asset-42" }]);
assert(!JSON.stringify(draft).includes("C:\\private\\attachment.txt"), "composer paths must not enter a Task handoff");

const environment: TaskManagerEnvironment = {
  key: "remote-windows",
  preset,
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
  projectLabel: "ShellX",
};
const durable = draftToTaskStoreDraft({
  ...draft,
  candidates: [{ providerId: "codex-cli", modelMode: "providerDefault", order: 1 }],
}, catalogue, environment);

const scheduledDurable = draftToTaskStoreDraft({
  ...draft,
  schedule: {
    ...draft.schedule,
    trigger: { kind: "once", atMs: 1_786_733_820_000 },
  },
  candidates: [{ providerId: "codex-cli", modelMode: "providerDefault", order: 1 }],
}, catalogue, environment);
assert.deepEqual(
  scheduledDurable.trigger,
  { kind: "once", atMs: 1_786_733_820_000 },
  "the renderer and native TaskTrigger boundary must retain the camelCase atMs wire field",
);

assert.deepEqual(durable.environment, {
  connectionId: "remote-windows",
  snapshotId: `sha256:${"a".repeat(64)}`,
  targetKey: "ssh:windows:user@windows-host.example:22",
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
});
assert.deepEqual(durable.candidates, [{
  order: 1,
  providerId: "codex-cli",
  model: { mode: "providerDefault" },
  capabilityRequirements: [],
  optionRefs: [],
}]);
assert.deepEqual(durable.attachmentRefs, [{ attachmentId: "asset-42" }]);
assert.equal(JSON.stringify(durable).includes("agentSuggestion"), false, "an originating chat agent cannot persist as an execution route");

const record: TaskStoreRecord = {
  definition: {
    taskId: "task-1",
    name: durable.name,
    enabled: false,
    paused: true,
    currentRevisionId: "task-1:r1",
    currentRevisionNumber: 1,
    currentRevisionHash: "b".repeat(64),
    retentionPolicy: durable.retentionPolicy,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  revision: {
    revisionId: "task-1:r1",
    taskId: "task-1",
    revisionNumber: 1,
    canonicalSha256: "b".repeat(64),
    createdAtMs: 1,
    ...durable,
  },
};
const localEnvironment: TaskManagerEnvironment = {
  key: "local",
  preset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
  projectLabel: "ShellX",
};
const localSummary = recordToTaskDefinitionSummary({
  definition: { ...record.definition, taskId: "task-local" },
  revision: {
    ...record.revision,
    taskId: "task-local",
    environment: { ...record.revision.environment, connectionId: "", targetKey: "local:windows" },
  },
}, [], new Map([["local", localEnvironment]]));
assert.equal(localSummary.environmentLabel, "This computer", "saved local tasks must keep the same user-owned environment name as the selector");
assert.equal(localSummary.providerRouteSummary, "Codex CLI", "saved task rows must omit internal default-model terminology");
const state = stateFor(record);
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let latestData: TaskManagerData | undefined;
const controller = createTaskManagerController({
  invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    if (command === "connections_list") return [preset] as T;
    if (command === "tasks_list") return [record] as T;
    if (command === "tasks_list_states") return [state] as T;
    if (command === "tasks_get") return record as T;
    if (command === "tasks_get_state") return state as T;
    if (command === "tasks_list_receipts") return [] as T;
    if (command === "tasks_create" || command === "tasks_revise") return record as T;
    if (command === "tasks_run_now") return { occurrenceId: `task-occurrence:v1:${"d".repeat(64)}`, disposition: "queued" } as T;
    if (command === "tasks_resolve_attention" || command === "tasks_resolve_attention_overflow") return undefined as T;
    if (command === "tasks_cancel_run") return undefined as T;
    if (command === "tasks_pause" || command === "tasks_resume") return record.definition as T;
    if (command === "tasks_delete") return undefined as T;
    throw new Error(`unexpected command ${command}`);
  },
  scanProviderCatalogue: async () => rawCatalogue,
  onData: (data) => { latestData = data; },
});
await controller.load({
  localPreset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  activeConnectionId: "remote-windows",
  canonicalCwd: "C:\\Users\\User\\shellx",
  projectId: "shellx",
  projectLabel: "ShellX",
});
assert(calls.some((call) => call.command === "tasks_list"), "controller must use the exact record-returning tasks_list command");
assert(calls.some((call) => call.command === "tasks_list_states"), "controller must load the bounded durable task-state projection");
assert.equal(calls.some((call) => call.command === "tasks_get"), false, "load must not reconstruct list rows from a guessed revision");
assert.equal(calls.some((call) => call.command === "tasks_list_receipts"), false, "load must not fetch a receipt list for every definition");
assert(latestData, "controller must publish loaded Task Manager data");
assert.equal(latestData.definitions.length, 1);
assert.equal(latestData.definitions[0]?.state, "paused", "initial rows use durable definition state until execution receipts are inspected");
await controller.selectDefinition("task-1");
assert(calls.some((call) => call.command === "tasks_get"), "selecting a definition must fetch its exact current record");
assert(calls.some((call) => call.command === "tasks_list_receipts"), "selecting a definition may fetch its bounded receipts");
const checked = await controller.requestProviderCatalogue({ environmentKey: "remote-windows", reason: "manualRecheck" });
assert.equal(checked.accepted, true);
const run = await controller.runNow({
  definitionId: "task-1",
  revisionId: "task-1:r1",
  revisionHash: "b".repeat(64),
});
assert.equal(run.accepted, true);
assert.deepEqual(calls.find((call) => call.command === "tasks_run_now")?.args, {
  request: {
    taskId: "task-1",
    revisionId: "task-1:r1",
    revisionHash: "b".repeat(64),
  },
});
const acknowledged = await controller.resolveAttention({
  definitionId: "task-1",
  attentionId: "attention-1",
  expectedOpenedAtMs: 20,
});
assert.equal(acknowledged.accepted, true);
assert.deepEqual(calls.find((call) => call.command === "tasks_resolve_attention")?.args, {
  request: { taskId: "task-1", attentionId: "attention-1", expectedOpenedAtMs: 20 },
});
const aggregateAcknowledged = await controller.resolveAttention({
  definitionId: "task-1",
  attentionId: "attention-overflow-1",
  expectedOpenedAtMs: 21,
  aggregateOmittedCount: 4,
  aggregateUpdatedAtMs: 22,
});
assert.equal(aggregateAcknowledged.accepted, true);
assert.deepEqual(calls.find((call) => call.command === "tasks_resolve_attention_overflow")?.args, {
  request: {
    taskId: "task-1",
    expectedAttentionId: "attention-overflow-1",
    expectedOmittedCount: 4,
    expectedUpdatedAtMs: 22,
  },
});
const cancelled = await controller.cancelRun({
  definitionId: "task-1",
  occurrenceId: `task-occurrence:v1:${"d".repeat(64)}`,
  attemptId: "attempt-1",
});
assert.equal(cancelled.accepted, true);
assert.deepEqual(calls.find((call) => call.command === "tasks_cancel_run")?.args, {
  request: { occurrenceId: `task-occurrence:v1:${"d".repeat(64)}`, attemptId: "attempt-1" },
});
const duplicated = await controller.duplicate({
  definitionId: "task-1",
  revisionId: "task-1:r1",
});
assert.equal(duplicated.accepted, true);
const duplicateCreateCall = calls.find((call) => call.command === "tasks_create");
assert.equal((duplicateCreateCall?.args?.request as { paused?: unknown })?.paused, true);
const duplicateDraft = (duplicateCreateCall?.args?.request as { draft?: typeof durable })?.draft;
assert.equal(duplicateDraft?.name, "Copy of Release checklist");
assert.equal(duplicateDraft?.origin, undefined, "a duplicate must not inherit originating chat identity");
assert.deepEqual(duplicateDraft?.attachmentRefs, durable.attachmentRefs, "reviewed durable attachment identities remain bound");
const createCountBeforeStaleDuplicate = calls.filter((call) => call.command === "tasks_create").length;
const staleDuplicate = await controller.duplicate({
  definitionId: "task-1",
  revisionId: "task-1:r0",
});
assert.equal(staleDuplicate.accepted, false);
assert.equal(
  calls.filter((call) => call.command === "tasks_create").length,
  createCountBeforeStaleDuplicate,
  "a stale duplicate request must stop before creating a definition",
);
const saved = await controller.save({
  ...draft,
  candidates: [{ providerId: "codex-cli", modelMode: "providerDefault", order: 1 }],
});
assert.equal(saved.accepted, true);
const createCall = calls.filter((call) => call.command === "tasks_create").at(-1);
assert.deepEqual(createCall?.args, { request: { draft: durable, paused: true } });

const firstLoad = deferred<ConnectionPreset[]>();
const loadCalls: string[] = [];
let raceLoadData: TaskManagerData;
const loadRaceController = createTaskManagerController({
  invoke: async <T,>(command: string): Promise<T> => {
    loadCalls.push(command);
    if (command === "connections_list") {
      if (loadCalls.filter((entry) => entry === "connections_list").length === 1) return firstLoad.promise as T;
      return [preset] as T;
    }
    if (command === "tasks_list") return [record] as T;
    if (command === "tasks_list_states") return [state] as T;
    throw new Error(`unexpected command ${command}`);
  },
  onData: (data) => { raceLoadData = data; },
});
const staleLoad = loadRaceController.load({
  localPreset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  activeConnectionId: "remote-windows",
  canonicalCwd: "C:\\old",
});
const currentLoad = loadRaceController.load({
  localPreset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  activeConnectionId: null,
  canonicalCwd: "C:\\current",
});
await currentLoad;
firstLoad.resolve([preset]);
await staleLoad;
assert.equal(loadCalls.filter((command) => command === "tasks_list").length, 1, "a stale load must not replace a newer logical environment");
assert.equal(raceLoadData!.environments.find((environment) => environment.key === "local")?.cwdLabel, "C:\\current");

const firstCatalogue = deferred<TaskProviderCatalog>();
const secondCatalogue = deferred<TaskProviderCatalog>();
let scanCall = 0;
let raceCatalogueData: TaskManagerData;
const catalogueRaceController = createTaskManagerController({
  invoke: async <T,>(command: string): Promise<T> => {
    if (command === "connections_list") return [preset] as T;
    if (command === "tasks_list") return [record] as T;
    if (command === "tasks_list_states") return [state] as T;
    throw new Error(`unexpected command ${command}`);
  },
  scanProviderCatalogue: async () => (scanCall++ === 0 ? firstCatalogue.promise : secondCatalogue.promise),
  onData: (data) => { raceCatalogueData = data; },
});
await catalogueRaceController.load({
  localPreset: { ...preset, id: "", label: "Current local", transport: { kind: "local" } },
  activeConnectionId: "remote-windows",
  canonicalCwd: "C:\\current",
});
const staleCatalogueRequest = catalogueRaceController.requestProviderCatalogue({ environmentKey: "remote-windows", reason: "manualRecheck" });
const currentCatalogueRequest = catalogueRaceController.requestProviderCatalogue({ environmentKey: "local", reason: "environmentChanged" });
secondCatalogue.resolve(rawCatalogue);
assert.equal((await currentCatalogueRequest).accepted, true);
firstCatalogue.resolve(rawCatalogue);
assert.equal((await staleCatalogueRequest).accepted, false, "an older catalogue response must not overwrite the newer environment");
assert.equal(raceCatalogueData!.providerCatalogue?.environmentKey, "local");

console.log("Task Manager app adapter passed: logical preset/target separation, durable composer provenance, no path handoff, bounded receipt inspection, exact-revision run queueing, request generation guards, Task-store payload mapping, and exact Tauri controller commands.");

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve: (value) => resolve!(value) };
}

function stateFor(value: TaskStoreRecord): TaskStoreStateProjection {
  return {
    schemaVersion: "shellx.task-state-projection.v1",
    taskId: value.definition.taskId,
    name: value.definition.name,
    currentRevisionId: value.definition.currentRevisionId,
    currentRevisionNumber: value.definition.currentRevisionNumber,
    savedEnvironment: {
      snapshotId: value.revision.environment.snapshotId,
      targetKey: value.revision.environment.targetKey,
    },
    state: value.definition.paused ? "paused" : "scheduled",
    attentionCount: 0,
    attentionCountCapped: false,
    attentionItemsTruncated: false,
    attentionResolution: "explicitFutureReceiptOrActionRequired",
    attention: [],
    runHistory: [],
  };
}
