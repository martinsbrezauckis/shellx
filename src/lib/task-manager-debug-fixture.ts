import type { TaskManagerData } from "./task-manager-contract";
import { TASK_MANAGER_FIXTURE_DATA } from "./task-manager-fixtures";

export type DebugTaskManagerFixtureMode =
  | "full"
  | "loading"
  | "empty"
  | "error"
  | "providerEmpty"
  | "providerGuard"
  | "vaultUnavailable"
  | "vaultRequired"
  | "traceIncomplete"
  | "traceNoActivity"
  | "resultIncomplete"
  | "resultNoActivity";

export function normalizeDebugTaskManagerFixtureMode(value: unknown): DebugTaskManagerFixtureMode | "clear" | null {
  return value === "clear" || DEBUG_TASK_MANAGER_FIXTURE_MODES.has(value as DebugTaskManagerFixtureMode)
    ? value as DebugTaskManagerFixtureMode | "clear"
    : null;
}

export function debugTaskManagerFixtureData(mode: DebugTaskManagerFixtureMode): TaskManagerData {
  const data = structuredClone(TASK_MANAGER_FIXTURE_DATA);
  const now = Date.now();
  if (data.providerCatalogue) {
    data.providerCatalogue.generatedAtMs = now - 1_000;
    data.providerCatalogue.freshUntilMs = now + 60_000;
    for (const provider of data.providerCatalogue.providers) {
      provider.availability.checkedAtMs = now - 1_000;
    }
  }
  if (mode === "loading") return { ...data, loadState: "loading", definitions: [], selectedDefinitionId: undefined, selectedDefinition: undefined };
  if (mode === "empty") return { ...data, loadState: "empty", definitions: [], selectedDefinitionId: undefined, selectedDefinition: undefined };
  if (mode === "error") return { ...data, loadState: "error", loadDetail: "Owned Task fixture could not load.", definitions: [], selectedDefinitionId: undefined, selectedDefinition: undefined };
  if (mode === "providerEmpty") return { ...data, providerCatalogue: undefined, providerCatalogueState: { state: "idle" } };
  if (mode === "providerGuard") return { ...data, providerCatalogueState: { state: "error", detail: "Owned provider check is unavailable." } };
  if (mode === "vaultUnavailable") return { ...data, vaultGrantOptions: [], vaultGrantState: { state: "unavailable", detail: "Owned Vault fixture is unavailable." } };
  if (mode === "vaultRequired") return { ...data, vaultGrantOptions: [], vaultGrantState: { state: "ready" } };
  const run = data.selectedDefinition?.runHistory.find((entry) => entry.id === "run-fixture-completed");
  if (!run) return data;
  if (mode === "traceIncomplete" && run.traceEvidence) {
    run.traceEvidence.state = "incomplete";
    run.traceEvidence.droppedEventCount = 2;
    run.conversationSessionId = undefined;
  } else if (mode === "traceNoActivity" && run.traceEvidence) {
    run.traceEvidence = {
      ...run.traceEvidence,
      state: "noProviderActivity",
      archiveSha256: undefined,
      archiveBytes: 0,
      recordCount: 0,
      providerEventCount: 0,
      droppedEventCount: 0,
      terminalMarkerPresent: false,
    };
    run.conversationSessionId = undefined;
  } else if (mode === "resultIncomplete" && run.resultEvidence) {
    run.resultEvidence.state = "incomplete";
    run.resultEvidence.exportedBrowserTaskCount = 0;
  } else if (mode === "resultNoActivity" && run.resultEvidence) {
    run.resultEvidence = {
      ...run.resultEvidence,
      state: "noBrowserActivity",
      browserTaskCount: 0,
      exportedBrowserTaskCount: 0,
      recorderCount: 0,
      evaluationCount: 0,
      identities: [],
    };
  }
  return data;
}

export function updateDebugTaskManagerState(
  data: TaskManagerData,
  action: "pause" | "resume" | "cancel" | "resolveAttention" | "delete" | "duplicate" | "runNow",
): TaskManagerData {
  const next = structuredClone(data);
  const selected = next.selectedDefinition;
  if (!selected) return next;
  const updateSummary = (state: typeof selected.state, enabled = selected.enabled): void => {
    selected.state = state;
    selected.enabled = enabled;
    next.definitions = next.definitions.map((definition) => (
      definition.id === selected.id ? { ...definition, state, enabled } : definition
    ));
  };
  if (action === "pause") updateSummary("paused", selected.enabled);
  if (action === "resume") updateSummary("recent", selected.enabled);
  if (action === "cancel") {
    const running = selected.runHistory.find((run) => run.state === "running");
    if (running) {
      running.state = "outcomeUnknown";
      running.attemptId = undefined;
      running.completedAtMs = Date.now();
    }
  }
  if (action === "resolveAttention") {
    selected.attentionItems = [];
    selected.attention = undefined;
    next.definitions = next.definitions.map((definition) => (
      definition.id === selected.id ? { ...definition, attention: undefined, state: "recent" } : definition
    ));
    selected.state = "recent";
  }
  if (action === "delete") {
    next.definitions = next.definitions.filter((definition) => definition.id !== selected.id);
    next.selectedDefinition = undefined;
    next.selectedDefinitionId = undefined;
    next.loadState = next.definitions.length === 0 ? "empty" : "ready";
  }
  if (action === "duplicate") {
    const duplicateId = "task-fixture-copy";
    const duplicate = {
      ...selected,
      id: duplicateId,
      revisionId: "revision-fixture-copy-001",
      name: `Copy of ${selected.name}`,
      state: "paused" as const,
      enabled: false,
      runHistory: [],
      attentionItems: [],
      attention: undefined,
    };
    next.definitions = [...next.definitions, duplicate];
    next.selectedDefinitionId = duplicateId;
    next.selectedDefinition = duplicate;
  }
  if (action === "runNow") {
    selected.runHistory = [{
      id: "run-fixture-manual",
      state: "pending",
      startedAtMs: Date.now(),
      receiptCount: 1,
      timeline: [{ receiptId: "receipt-run-now", occurredAtMs: Date.now(), kind: "occurrenceScheduled" }],
    }, ...selected.runHistory];
  }
  return next;
}

const DEBUG_TASK_MANAGER_FIXTURE_MODES = new Set<DebugTaskManagerFixtureMode>([
  "full",
  "loading",
  "empty",
  "error",
  "providerEmpty",
  "providerGuard",
  "vaultUnavailable",
  "vaultRequired",
  "traceIncomplete",
  "traceNoActivity",
  "resultIncomplete",
  "resultNoActivity",
]);
