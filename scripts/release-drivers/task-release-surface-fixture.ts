import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "../lib/release-surface-run-profile";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

export const TASK_DEBUG_API_SURFACES = [
  "DELETE /tasks/:task_id",
  "GET /tasks",
  "GET /tasks/:task_id",
  "GET /tasks/:task_id/attention",
  "GET /tasks/:task_id/receipts",
  "GET /tasks/:task_id/state",
  "GET /tasks/states",
  "POST /tasks",
  "POST /tasks/agent",
  "POST /tasks/:task_id/attention/:attention_id/resolve",
  "POST /tasks/:task_id/attention/overflow/resolve",
  "POST /tasks/:task_id/pause",
  "POST /tasks/:task_id/resume",
  "POST /tasks/:task_id/revise",
  "POST /tasks/:task_id/run",
  "POST /tasks/provider-catalog",
  "POST /tasks/runs/:occurrence_id/cancel",
] as const;

export const TASK_TAURI_COMMANDS = [
  "cut_tooling_open",
  "task_provider_catalog",
  "tasks_cancel_run",
  "tasks_create",
  "tasks_delete",
  "tasks_get",
  "tasks_get_state",
  "tasks_list",
  "tasks_list_open_attention",
  "tasks_list_receipts",
  "tasks_list_states",
  "tasks_maintain_attachments",
  "tasks_pause",
  "tasks_persist_attachments",
  "tasks_reclaim_attachments",
  "tasks_resolve_attention",
  "tasks_resolve_attention_overflow",
  "tasks_resume",
  "tasks_revise",
  "tasks_run_now",
] as const;

export type TaskDebugApiSurface = typeof TASK_DEBUG_API_SURFACES[number];
export type TaskTauriCommand = typeof TASK_TAURI_COMMANDS[number];
export type JsonRecord = Record<string, unknown>;

export interface TaskProviderCatalogueFixture {
  schemaVersion: "shellx.task-provider-catalog.v1";
  snapshotId: string;
  generatedAtMs: number;
  freshUntilMs: number;
  target: { key: string; transport: string; runtime: string; label: string };
  providers: JsonRecord[];
}

export interface TaskRecordFixture {
  definition: {
    taskId: string;
    name: string;
    enabled: boolean;
    paused: boolean;
    currentRevisionId: string;
    currentRevisionNumber: number;
    currentRevisionHash: string;
    deletedAtMs?: number;
  };
  revision: JsonRecord & {
    revisionId: string;
    taskId: string;
    revisionNumber: number;
    canonicalSha256: string;
    name: string;
  };
}

export interface TaskFixtureContext {
  profileRoot: string;
  catalogue: TaskProviderCatalogueFixture;
  draft: JsonRecord;
  task: TaskRecordFixture;
}

export function assertIsolatedTaskReleaseProfile(request: ReleaseSurfaceDriverRequest): string {
  const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const profileName = basename(profileRoot.replaceAll("\\", "/"));
  const match = /^shellx-final-webdriver-([a-f0-9]{16,64})$/.exec(profileName);
  if (!match) throw new Error("Task release fixture requires the exact isolated final-candidate profile");
  const markerPath = releaseSurfaceProfileMarkerLaunchPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("Task release fixture could not read its isolated profile marker");
  }
  const row = requireRecord(marker, "Task release profile marker");
  if (row.schema !== "shellx/release-surface-run-profile@1"
    || row.platform !== request.platform
    || row.runId !== match[1]
    || normalizePath(String(row.launchPath ?? "")) !== normalizePath(profileRoot)) {
    throw new Error("Task release profile marker does not bind the exact candidate runtime");
  }
  return profileRoot;
}

export function localTaskProviderPreset(): JsonRecord {
  return {
    id: "",
    label: "Final Task surface local runtime",
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
    providerScan: [],
  };
}

export function taskDraft(
  request: ReleaseSurfaceDriverRequest,
  profileRoot: string,
  catalogue: TaskProviderCatalogueFixture,
  revisionNumber = 1,
): JsonRecord {
  return {
    name: `Final Task surface ${request.sourceCommit.slice(0, 12)} r${revisionNumber}`,
    instruction: "Produce one bounded local status summary without network or external side effects.",
    successCriteria: "Return one receipt-backed local summary.",
    noChangeCriteria: "No external state is changed.",
    environment: {
      connectionId: "local",
      snapshotId: catalogue.snapshotId,
      targetKey: catalogue.target.key,
      canonicalCwd: profileRoot,
      projectId: `final-task-${request.sourceCommit.slice(0, 12)}`,
    },
    candidates: [{
      order: 1,
      providerId: "grok",
      model: { mode: "providerDefault" },
      capabilityRequirements: [],
      optionRefs: [],
    }],
    executionPolicy: {
      permissionMode: "default",
      autonomyMode: "default",
      toolExposureIds: [],
    },
    attachmentRefs: [],
    vaultRequirements: [],
    trigger: { kind: "manual" },
    timezone: "UTC",
    missedRunPolicy: "skip",
    concurrencyPolicy: { maxActiveRuns: 1 },
    timeoutPolicy: { maxRunSeconds: 60 },
    retryPolicy: { maxAttempts: 1, idempotentObservationOnly: false },
    notificationPolicy: "none",
    retentionPolicy: { maxReceipts: 32 },
    origin: { tabId: `final-task-${request.sourceCommit.slice(0, 16)}` },
  };
}

export function verifyTaskProviderCatalogue(value: unknown): TaskProviderCatalogueFixture {
  const catalogue = requireRecord(value, "Task provider catalogue");
  const target = requireRecord(catalogue.target, "Task provider catalogue target");
  const providers = requireArray(catalogue.providers, "Task provider catalogue providers")
    .map((provider) => requireRecord(provider, "Task provider catalogue provider"));
  if (catalogue.schemaVersion !== "shellx.task-provider-catalog.v1"
    || !/^sha256:[a-f0-9]{64}$/.test(String(catalogue.snapshotId ?? ""))
    || !Number.isSafeInteger(catalogue.generatedAtMs)
    || !Number.isSafeInteger(catalogue.freshUntilMs)
    || Number(catalogue.freshUntilMs) <= Number(catalogue.generatedAtMs)
    || typeof target.key !== "string" || !target.key
    || typeof target.transport !== "string" || !target.transport
    || typeof target.runtime !== "string" || !target.runtime
    || typeof target.label !== "string" || !target.label) {
    throw new Error("Task provider catalogue omitted its exact fresh target identity");
  }
  const providerIds = providers.map((provider) => String(provider.providerId ?? "")).sort();
  if (JSON.stringify(providerIds) !== JSON.stringify([
    "antigravity-cli", "claude-code", "codex-cli", "grok",
  ])) {
    throw new Error("Task provider catalogue did not return the exact normalized provider set");
  }
  for (const provider of providers) {
    const availability = requireRecord(provider.availability, "Task provider availability");
    if (typeof availability.status !== "string" || !availability.status
      || typeof availability.canRun !== "boolean"
      || !Number.isSafeInteger(availability.checkedAtMs)
      || typeof availability.detail !== "string"
      || !Array.isArray(provider.capabilityGuidance)
      || !Array.isArray(provider.models) || provider.models.length !== 0
      || provider.defaultModelMode !== "providerDefault") {
      throw new Error("Task provider catalogue exposed an invalid availability projection");
    }
    for (const forbidden of ["binary", "binarySha256", "binaryBytes", "auth", "credential"] ) {
      if (forbidden in provider || forbidden in availability) {
        throw new Error(`Task provider catalogue exposed forbidden ${forbidden} data`);
      }
    }
  }
  return catalogue as unknown as TaskProviderCatalogueFixture;
}

export function verifyTaskRecord(
  value: unknown,
  expectedName: string,
  expectedPaused?: boolean,
  expectedRevisionNumber?: number,
): TaskRecordFixture {
  const record = requireRecord(value, "Task definition record");
  const definition = requireRecord(record.definition, "Task definition");
  const revision = requireRecord(record.revision, "Task revision");
  const taskId = String(definition.taskId ?? "");
  const revisionNumber = Number(definition.currentRevisionNumber);
  const revisionId = String(definition.currentRevisionId ?? "");
  const revisionHash = String(definition.currentRevisionHash ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId)
    || definition.name !== expectedName
    || typeof definition.enabled !== "boolean"
    || typeof definition.paused !== "boolean"
    || definition.enabled === definition.paused
    || !Number.isSafeInteger(revisionNumber) || revisionNumber < 1
    || revisionId !== `${taskId}:r${revisionNumber}`
    || !/^[a-f0-9]{64}$/.test(revisionHash)
    || revision.taskId !== taskId
    || revision.revisionId !== revisionId
    || revision.revisionNumber !== revisionNumber
    || revision.canonicalSha256 !== revisionHash
    || revision.name !== expectedName) {
    throw new Error("Task definition record lost its definition/revision/CAS identity");
  }
  if (expectedPaused !== undefined && definition.paused !== expectedPaused) {
    throw new Error(`Task definition expected paused=${expectedPaused}`);
  }
  if (expectedRevisionNumber !== undefined && revisionNumber !== expectedRevisionNumber) {
    throw new Error(`Task definition expected revision ${expectedRevisionNumber}`);
  }
  return record as unknown as TaskRecordFixture;
}

export function verifyTaskDefinition(value: unknown, task: TaskRecordFixture, paused: boolean): void {
  const definition = requireRecord(value, "Task definition mutation");
  if (definition.taskId !== task.definition.taskId
    || definition.paused !== paused
    || definition.enabled === paused
    || definition.currentRevisionId !== task.definition.currentRevisionId
    || definition.currentRevisionHash !== task.definition.currentRevisionHash) {
    throw new Error("Task definition mutation did not preserve exact revision identity");
  }
}

export function verifyTaskState(value: unknown, task: TaskRecordFixture): void {
  const state = requireRecord(value, "Task state");
  if (state.schemaVersion !== "shellx.task-state-projection.v1"
    || state.taskId !== task.definition.taskId
    || state.currentRevisionId !== task.definition.currentRevisionId
    || state.currentRevisionNumber !== task.definition.currentRevisionNumber
    || typeof state.state !== "string"
    || !Number.isSafeInteger(state.attentionCount)
    || !Array.isArray(state.attention)
    || !Array.isArray(state.runHistory)) {
    throw new Error("Task state projection did not bind the exact current revision");
  }
}

export function verifyTaskReceipts(value: unknown, task: TaskRecordFixture): void {
  const receipts = requireArray(value, "Task receipts");
  if (receipts.length === 0 || receipts.length > 256) {
    throw new Error("Task receipt tail was empty or unbounded");
  }
  let previousSequence = 0;
  for (const receiptValue of receipts) {
    const receipt = requireRecord(receiptValue, "Task receipt");
    if (receipt.schemaVersion !== "shellx.task-receipt.v1"
      || receipt.taskId !== task.definition.taskId
      || !Number.isSafeInteger(receipt.sequence)
      || Number(receipt.sequence) <= previousSequence
      || typeof receipt.receiptHash !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.receiptHash)) {
      throw new Error("Task receipt tail lost its bounded hash-linked identity");
    }
    previousSequence = Number(receipt.sequence);
  }
}

export function verifyTaskError(value: unknown, code: string): void {
  const body = requireRecord(value, `Task error ${code}`);
  const error = requireRecord(body.error, `Task error ${code}.error`);
  if (body.ok !== false || error.code !== code || typeof error.message !== "string" || !error.message) {
    throw new Error(`Task request did not return the exact ${code} error contract`);
  }
}

export function taskDebugOracle(name: TaskDebugApiSurface): string {
  return `debug-api:tasks:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function taskTauriOracle(name: TaskTauriCommand): string {
  return `tauri:tasks:${name.replaceAll("_", "-")}`;
}

export function requireRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
