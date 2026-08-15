import type { ConnectionPreset } from "../components/ConnectionPicker";
import type { TaskProviderCatalog } from "./task-provider-catalog";
import {
  taskScheduleSummary,
  type TaskDefinitionDetail,
  type TaskDefinitionSummary,
  type TaskExecutionCandidate,
  type TaskManagerDraft,
  type TaskManagerDraftContext,
  type TaskManagerState,
  type TaskProviderReceiptReason,
  type TaskProviderReceiptVerdict,
  type TaskProviderCatalogue,
  type TaskRunHistoryEntry,
  type TaskRunTimelineEntry,
} from "./task-manager-contract";

/** Exact JSON projection of `src-tauri/src/task_model.rs`. */
export interface TaskStoreDraft {
  name: string;
  instruction: string;
  successCriteria?: string;
  noChangeCriteria?: string;
  environment: {
    connectionId: string;
    snapshotId: string;
    targetKey: string;
    canonicalCwd: string;
    projectId?: string;
  };
  candidates: Array<{
    order: number;
    providerId: string;
    model: { mode: "providerDefault" } | { mode: "verifiedModel"; modelId: string };
    capabilityRequirements: string[];
    optionRefs: Array<{ optionId: string; referenceId: string }>;
  }>;
  executionPolicy: {
    permissionMode: string;
    autonomyMode: string;
    toolExposureIds: string[];
  };
  attachmentRefs: Array<{ attachmentId: string; digest?: string }>;
  workflow?: { workflowId: string; digest: string };
  vaultRequirements: Array<{ keyId: string; grantId?: string }>;
  trigger: TaskManagerDraft["schedule"]["trigger"];
  timezone: string;
  missedRunPolicy: TaskManagerDraft["schedule"]["missedRunPolicy"];
  concurrencyPolicy: { maxActiveRuns: number };
  timeoutPolicy: { maxRunSeconds: number };
  retryPolicy: { maxAttempts: number; idempotentObservationOnly: boolean };
  notificationPolicy: TaskManagerDraft["schedule"]["notificationPolicy"];
  retentionPolicy: { maxReceipts: number };
  origin?: { sessionId?: string; tabId?: string };
}

export interface TaskStoreDefinition {
  taskId: string;
  name: string;
  enabled: boolean;
  paused: boolean;
  currentRevisionId: string;
  currentRevisionNumber: number;
  currentRevisionHash: string;
  retentionPolicy: { maxReceipts: number };
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs?: number;
}

export interface TaskStoreRevision {
  revisionId: string;
  taskId: string;
  revisionNumber: number;
  canonicalSha256: string;
  createdAtMs: number;
  name: string;
  instruction: string;
  successCriteria?: string;
  noChangeCriteria?: string;
  environment: TaskStoreDraft["environment"];
  candidates: TaskStoreDraft["candidates"];
  executionPolicy: TaskStoreDraft["executionPolicy"];
  attachmentRefs: TaskStoreDraft["attachmentRefs"];
  workflow?: TaskStoreDraft["workflow"];
  vaultRequirements: TaskStoreDraft["vaultRequirements"];
  trigger: TaskStoreDraft["trigger"];
  timezone: string;
  missedRunPolicy: TaskStoreDraft["missedRunPolicy"];
  concurrencyPolicy: TaskStoreDraft["concurrencyPolicy"];
  timeoutPolicy: TaskStoreDraft["timeoutPolicy"];
  retryPolicy: TaskStoreDraft["retryPolicy"];
  notificationPolicy: TaskStoreDraft["notificationPolicy"];
  retentionPolicy: TaskStoreDraft["retentionPolicy"];
  origin?: TaskStoreDraft["origin"];
}

export interface TaskStoreRecord {
  definition: TaskStoreDefinition;
  revision: TaskStoreRevision;
}

export interface TaskStoreReceipt {
  schemaVersion: "shellx.task-receipt.v1";
  receiptId: string;
  sequence: number;
  taskId: string;
  revisionId?: string;
  revisionHash?: string;
  kind: "definitionCreated" | "revisionCreated" | "paused" | "resumed" | "deleted"
    | "occurrenceCreated" | "occurrenceClaimed" | "occurrenceHeartbeat"
    | "occurrenceCompleted" | "occurrenceOutcomeUnknown" | "occurrenceProviderDecision"
    | "notificationAttempted" | "occurrenceResultEvidence" | "occurrenceTraceEvidence";
  paused: boolean;
  occurredAtMs: number;
  previousReceiptHash?: string;
  execution?: {
    occurrenceId: string;
    attemptId?: string;
    transition: "occurrenceCreated" | "claimed" | "heartbeat" | "completed" | "outcomeUnknown" | "providerDecision" | "notificationAttempted";
    environment?: { snapshotId: string; targetKey: string };
    providerDecision?: {
      catalogueSnapshotId?: string;
      catalogueGeneratedAtMs?: number;
      catalogueFreshUntilMs?: number;
      stage?: "preflight" | "routeSelected" | "committedStart" | "terminal";
      candidateOrder?: number;
      providerId?: string;
      verdict: "eligible" | "rejectedPreEffect" | "selected" | "started" | "succeeded" | "failed" | "outcomeUnknown";
      reasonCode?: string;
      sessionId?: string;
    };
  };
  resultEvidence?: {
    schemaVersion: "shellx.task-result-evidence.v1";
    occurrenceId: string;
    attemptId: string;
    browserOwnerSessionId: string;
    sourceTerminalReceiptId: string;
    sourceTerminalReceiptSequence: number;
    sourceTerminalReceiptHash: string;
    state: "complete" | "incomplete" | "noBrowserActivity";
    browserTaskCount: number;
    exportedBrowserTaskCount: number;
    identities: Array<{
      kind: "browserFlightRecorder" | "browserEvaluation";
      browserTaskId: string;
      evidenceId: string;
      artifactSha256: string;
      evidenceDigest?: string;
      browserReceiptId: string;
      evidenceComplete: boolean;
      createdAtMs: number;
    }>;
    recordedAtMs: number;
  };
  traceEvidence?: {
    schemaVersion: "shellx.task-trace-evidence.v1";
    occurrenceId: string;
    attemptId: string;
    conversationSessionId?: string;
    sourceTerminalReceiptId: string;
    sourceTerminalReceiptSequence: number;
    sourceTerminalReceiptHash: string;
    state: "complete" | "incomplete" | "noProviderActivity";
    archiveSha256?: string;
    archiveBytes: number;
    recordCount: number;
    providerEventCount: number;
    droppedEventCount: number;
    initialContextComplete: boolean;
    terminalMarkerPresent: boolean;
    archiveFormatValid: boolean;
    recoveredAfterRestart: boolean;
    recordedAtMs: number;
  };
  receiptHash: string;
}

/** Exact renderer-safe projection of `task_state_projection.rs`. */
export interface TaskStoreStateProjection {
  schemaVersion: "shellx.task-state-projection.v1";
  taskId: string;
  name: string;
  currentRevisionId: string;
  currentRevisionNumber: number;
  savedEnvironment: { snapshotId: string; targetKey: string };
  state: "needsAttention" | "running" | "scheduled" | "paused" | "recent";
  attentionCount: number;
  attentionCountCapped: boolean;
  attentionItemsTruncated: boolean;
  attentionResolution: "explicitFutureReceiptOrActionRequired";
  attention: Array<{
    attentionId: string;
    source: "missedSchedule" | "occurrenceOutcomeUnknown" | "providerTerminalFailed" | "providerTerminalOutcomeUnknown" | "attentionLedgerSaturated";
    occurrenceId?: string;
    revisionId: string;
    occurredAtMs: number;
    reasonCode: string;
    aggregateOmittedCount?: number;
    aggregateUpdatedAtMs?: number;
    resolution: "explicitFutureReceiptOrActionRequired";
  }>;
  nextRunAtMs?: number;
  runHistory: Array<{
    occurrenceId: string;
    revisionId: string;
    revisionNumber: number;
    scheduledAtMs: number;
    state: "pending" | "running" | "completed" | "outcomeUnknown" | "needsAttention";
    activeAttemptId?: string;
    updatedAtMs: number;
    latestProviderDecision?: {
      candidateOrder: number;
      providerId: string;
      stage: "preflight" | "routeSelected" | "committedStart" | "terminal";
      verdict: "eligible" | "rejectedPreEffect" | "selected" | "started" | "succeeded" | "failed" | "outcomeUnknown";
      reasonCode?: string;
      freshCatalogue: { snapshotId: string; generatedAtMs: number; freshUntilMs: number };
    };
    conversationSessionId?: string;
    traceEvidence?: {
      state: "complete" | "incomplete" | "noProviderActivity";
      archiveSha256?: string;
      archiveBytes: number;
      recordCount: number;
      providerEventCount: number;
      droppedEventCount: number;
      terminalMarkerPresent: boolean;
      recoveredAfterRestart: boolean;
      recordedAtMs: number;
    };
    resultEvidence?: {
      state: "complete" | "incomplete" | "noBrowserActivity";
      browserTaskCount: number;
      exportedBrowserTaskCount: number;
      recorderCount: number;
      evaluationCount: number;
      identities: Array<{
        kind: "browserFlightRecorder" | "browserEvaluation";
        evidenceId: string;
        artifactSha256: string;
        evidenceDigest?: string;
        browserReceiptId: string;
        evidenceComplete: boolean;
        createdAtMs: number;
      }>;
      recordedAtMs: number;
    };
  }>;
}

export interface TaskManagerEnvironment {
  key: string;
  preset: ConnectionPreset;
  canonicalCwd?: string;
  projectId?: string;
  projectLabel?: string;
}

export interface TaskComposerHandoffInput {
  requestId: string;
  tabId: string;
  sessionId?: string;
  connectionKey: string;
  canonicalCwd: string;
  projectId?: string;
  agentSuggestion?: string;
  permissionMode: string;
  autonomyMode: string;
  toolExposureIds: string[];
  /** Already durable Task attachment references only. Never pass composer paths here. */
  attachmentRefs: Array<{ attachmentId: string; digest?: string }>;
  visiblePrompt: string;
  suggestedName?: string;
  timezone: string;
}

export interface BrowserTeachTaskDraftInput extends TaskComposerHandoffInput {
  workflow: { workflowId: string; digest: string };
  vaultKeyIds: string[];
}

export function taskEnvironmentKey(connectionId: string | null | undefined): string {
  return connectionId?.trim() || "local";
}

/**
 * Creates a reviewed Task Manager draft from visible composer state. The chat
 * agent remains a suggestion in context; no provider candidate is selected
 * until the operator chooses a route in Task Manager.
 */
export function createComposerTaskDraft(input: TaskComposerHandoffInput): TaskManagerDraft {
  return {
    originRequestId: input.requestId,
    originRevision: 1,
    name: input.suggestedName?.trim() || "",
    instruction: input.visiblePrompt,
    environmentKey: input.connectionKey,
    schedule: {
      trigger: { kind: "manual" },
      timezone: input.timezone,
      missedRunPolicy: "skip",
      maxRunSeconds: 600,
      notificationPolicy: "attentionOnly",
    },
    enabled: false,
    candidates: [],
    context: {
      connectionKey: input.connectionKey,
      canonicalCwd: input.canonicalCwd,
      projectId: input.projectId,
      agentSuggestion: input.agentSuggestion,
      permissionMode: input.permissionMode,
      autonomyMode: input.autonomyMode,
      toolExposureIds: [...input.toolExposureIds],
      attachmentRefs: input.attachmentRefs.map((attachment) => ({ ...attachment })),
      origin: { sessionId: input.sessionId, tabId: input.tabId },
    },
  };
}

/**
 * Builds a paused Task draft from an exact operator-reviewed Browser Teach
 * handoff. Provider routes and Vault grants remain unselected until reviewed
 * in Task Manager.
 */
export function createBrowserTeachTaskDraft(input: BrowserTeachTaskDraftInput): TaskManagerDraft {
  const draft = createComposerTaskDraft(input);
  const workflowId = input.workflow.workflowId.trim();
  const digest = input.workflow.digest.trim().toLowerCase();
  if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(workflowId) || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("The reviewed Browser workflow identity is invalid.");
  }
  const vaultKeyIds = [...new Set(input.vaultKeyIds.map((value) => value.trim()))];
  if (vaultKeyIds.length > 16 || vaultKeyIds.some((value) => !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("The reviewed Browser workflow has invalid Vault key identities.");
  }
  return {
    ...draft,
    context: {
      ...draft.context!,
      workflow: { workflowId, digest },
      vaultRequirements: vaultKeyIds.map((keyId) => ({ keyId })),
    },
  };
}

export function toTaskProviderCatalogue(
  catalogue: TaskProviderCatalog,
  environmentKey: string,
): TaskProviderCatalogue {
  return {
    ...catalogue,
    environmentKey,
    providers: catalogue.providers.map((provider) => ({
      ...provider,
      availability: {
        ...provider.availability,
        // The Rust catalogue rejects `unknown`; retain a defensive stale
        // state in the renderer if an older host ever sends one.
        status: provider.availability.status === "unknown" ? "stale" : provider.availability.status,
      },
      models: provider.models
        .filter((model) => model.source === "providerNative" && Number.isFinite(model.verifiedAtMs))
        .map((model) => ({
          id: model.id,
          label: model.label,
          source: "providerNative" as const,
          verifiedAtMs: model.verifiedAtMs!,
        })),
    })),
  };
}

export function taskEnvironmentOption(environment: TaskManagerEnvironment) {
  const { preset } = environment;
  return {
    key: environment.key,
    label: preset.id ? preset.label : "This computer",
    transport: preset.transport.kind,
    runtime: runtimeLabel(preset),
    projectLabel: environment.projectLabel,
    cwdLabel: environment.canonicalCwd,
  };
}

export function recordToTaskDefinitionDetail(
  record: TaskStoreRecord,
  receipts: TaskStoreReceipt[],
  environments: ReadonlyMap<string, TaskManagerEnvironment>,
  projection?: TaskStoreStateProjection,
): TaskDefinitionDetail {
  const summary = recordToTaskDefinitionSummary(record, receipts, environments, projection);
  const revision = record.revision;
  return {
    ...summary,
    instruction: revision.instruction,
    successCriteria: revision.successCriteria,
    candidates: revision.candidates.map(toUiCandidate),
    schedule: {
      trigger: revision.trigger,
      timezone: revision.timezone,
      missedRunPolicy: revision.missedRunPolicy,
      maxRunSeconds: revision.timeoutPolicy.maxRunSeconds,
      notificationPolicy: revision.notificationPolicy,
    },
    permissionSummary: `${revision.executionPolicy.permissionMode} · ${revision.executionPolicy.autonomyMode}`,
    notificationSummary: revision.notificationPolicy,
    workflowSummary: revision.workflow ? revision.workflow.workflowId : undefined,
    vaultSummary: revision.vaultRequirements.length > 0 ? `${revision.vaultRequirements.length} named requirement${revision.vaultRequirements.length === 1 ? "" : "s"}` : undefined,
    runHistory: projection
      ? projectionToRunHistory(record, projection, receipts)
      : receiptsToRunHistory(receipts),
    attentionItems: projection?.taskId === record.definition.taskId
      ? projection.attention.map((item) => ({
          attentionId: item.attentionId,
          source: item.source,
          occurrenceId: item.occurrenceId,
          revisionId: item.revisionId,
          openedAtMs: item.occurredAtMs,
          aggregateOmittedCount: item.aggregateOmittedCount,
          aggregateUpdatedAtMs: item.aggregateUpdatedAtMs,
        }))
      : [],
    draftContext: revisionToContext(revision),
  };
}

export function recordToTaskDefinitionSummary(
  record: TaskStoreRecord,
  receipts: TaskStoreReceipt[],
  environments: ReadonlyMap<string, TaskManagerEnvironment>,
  projection?: TaskStoreStateProjection,
): TaskDefinitionSummary {
  const { definition, revision } = record;
  const environmentKey = taskEnvironmentKey(revision.environment.connectionId);
  const environment = environments.get(environmentKey);
  const exactProjection = projection?.taskId === definition.taskId
    && projection.currentRevisionId === definition.currentRevisionId
    ? projection
    : undefined;
  const stateInfo = exactProjection
    ? { state: exactProjection.state as TaskManagerState }
    : taskState(definition, receipts);
  const schedule = {
    trigger: revision.trigger,
    timezone: revision.timezone,
    missedRunPolicy: revision.missedRunPolicy,
    maxRunSeconds: revision.timeoutPolicy.maxRunSeconds,
    notificationPolicy: revision.notificationPolicy,
  };
  return {
    id: definition.taskId,
    revisionId: definition.currentRevisionId,
    revisionHash: definition.currentRevisionHash,
    name: definition.name,
    instructionPreview: preview(revision.instruction),
    state: stateInfo.state,
    enabled: definition.enabled && !definition.paused,
    environmentKey,
    environmentLabel: environment?.preset.transport.kind === "local" ? "This computer" : environment?.preset.label ?? revision.environment.targetKey,
    projectLabel: environment?.projectLabel ?? revision.environment.projectId,
    providerIds: revision.candidates.map((candidate) => candidate.providerId),
    providerRouteSummary: revision.candidates.map((candidate) => candidate.model.mode === "providerDefault"
      ? taskProviderLabel(candidate.providerId)
      : `${taskProviderLabel(candidate.providerId)} · ${candidate.model.modelId}`).join(" → "),
    scheduleSummary: taskScheduleSummary(schedule),
    updatedAtMs: definition.updatedAtMs,
    attention: exactProjection ? projectionAttention(exactProjection) : undefined,
  };
}

/** Builds the exact `TaskDraft` payload expected by tasks_create/tasks_revise. */
export function draftToTaskStoreDraft(
  draft: TaskManagerDraft,
  catalogue: TaskProviderCatalogue | undefined,
  environment: TaskManagerEnvironment | undefined,
  existing?: TaskStoreRevision,
): TaskStoreDraft {
  if (!catalogue || catalogue.environmentKey !== draft.environmentKey || !catalogue.snapshotId) {
    throw new Error("Provider availability must be checked for the selected logical environment before saving.");
  }
  if (!environment || environment.key !== draft.environmentKey) {
    throw new Error("The selected logical environment is no longer available. Reload saved connections before saving.");
  }
  const context = draft.context ?? (existing ? revisionToContext(existing) : undefined);
  if (!context || context.connectionKey !== draft.environmentKey || !context.canonicalCwd.trim()) {
    throw new Error("Choose this environment from a session with a visible working folder before saving.");
  }
  const existingMetadata = context.candidateMetadata ?? {};
  return {
    name: draft.name,
    instruction: draft.instruction,
    successCriteria: optionalText(draft.successCriteria),
    noChangeCriteria: optionalText(context.noChangeCriteria),
    environment: {
      connectionId: environment.key,
      snapshotId: catalogue.snapshotId,
      targetKey: catalogue.target.key,
      canonicalCwd: context.canonicalCwd,
      projectId: context.projectId,
    },
    candidates: draft.candidates.map((candidate, index) => ({
      order: index + 1,
      providerId: candidate.providerId,
      model: candidate.modelMode === "verifiedModel" && candidate.modelId
        ? { mode: "verifiedModel" as const, modelId: candidate.modelId }
        : { mode: "providerDefault" as const },
      capabilityRequirements: existingMetadata[candidate.providerId]?.capabilityRequirements ?? [],
      optionRefs: existingMetadata[candidate.providerId]?.optionRefs ?? [],
    })),
    executionPolicy: {
      permissionMode: context.permissionMode,
      autonomyMode: context.autonomyMode,
      toolExposureIds: context.toolExposureIds,
    },
    attachmentRefs: context.attachmentRefs.map((attachment) => ({ ...attachment })),
    workflow: context.workflow ? { ...context.workflow } : undefined,
    vaultRequirements: (context.vaultRequirements ?? []).map((requirement) => ({ ...requirement })),
    trigger: draft.schedule.trigger,
    timezone: draft.schedule.timezone,
    missedRunPolicy: draft.schedule.missedRunPolicy,
    concurrencyPolicy: context.concurrencyPolicy ?? { maxActiveRuns: 1 },
    timeoutPolicy: { maxRunSeconds: draft.schedule.maxRunSeconds },
    retryPolicy: context.retryPolicy ?? { maxAttempts: 1, idempotentObservationOnly: false },
    notificationPolicy: draft.schedule.notificationPolicy,
    retentionPolicy: context.retentionPolicy ?? { maxReceipts: 128 },
    origin: context.origin ? { ...context.origin } : undefined,
  };
}

export function revisionToContext(revision: TaskStoreRevision): TaskManagerDraftContext {
  return {
    connectionKey: taskEnvironmentKey(revision.environment.connectionId),
    canonicalCwd: revision.environment.canonicalCwd,
    projectId: revision.environment.projectId,
    permissionMode: revision.executionPolicy.permissionMode,
    autonomyMode: revision.executionPolicy.autonomyMode,
    toolExposureIds: [...revision.executionPolicy.toolExposureIds],
    attachmentRefs: revision.attachmentRefs.map((attachment) => ({ ...attachment })),
    origin: revision.origin ? { ...revision.origin } : undefined,
    noChangeCriteria: revision.noChangeCriteria,
    workflow: revision.workflow ? { ...revision.workflow } : undefined,
    vaultRequirements: revision.vaultRequirements.map((requirement) => ({ ...requirement })),
    concurrencyPolicy: { ...revision.concurrencyPolicy },
    retryPolicy: { ...revision.retryPolicy },
    retentionPolicy: { ...revision.retentionPolicy },
    candidateMetadata: Object.fromEntries(revision.candidates.map((candidate) => [candidate.providerId, {
      capabilityRequirements: [...candidate.capabilityRequirements],
      optionRefs: candidate.optionRefs.map((reference) => ({ ...reference })),
    }])),
  };
}

function taskState(definition: TaskStoreDefinition, receipts: TaskStoreReceipt[]): { state: TaskManagerState; attentionReason?: string } {
  const latestExecution = [...receipts].reverse().find((receipt) => receipt.execution);
  const verdict = latestExecution?.execution?.providerDecision?.verdict;
  if (latestExecution?.kind === "occurrenceOutcomeUnknown" || verdict === "outcomeUnknown") {
    return { state: "needsAttention", attentionReason: "A previous occurrence has an unknown outcome." };
  }
  if (verdict === "failed" || verdict === "rejectedPreEffect") {
    return { state: "needsAttention", attentionReason: latestExecution?.execution?.providerDecision?.reasonCode ?? "A provider route needs attention." };
  }
  if (latestExecution?.kind === "occurrenceClaimed" || latestExecution?.kind === "occurrenceHeartbeat" || verdict === "started") {
    return { state: "running" };
  }
  if (definition.paused || !definition.enabled) return { state: "paused" };
  return { state: "scheduled" };
}

function projectionAttention(
  projection: TaskStoreStateProjection,
): TaskDefinitionSummary["attention"] {
  if (!Number.isInteger(projection.attentionCount) || projection.attentionCount <= 0) return undefined;
  const sources = new Set(projection.attention.map((item) => item.source));
  const kind = sources.has("occurrenceOutcomeUnknown") || sources.has("providerTerminalOutcomeUnknown")
    ? "outcomeUnknown"
    : sources.has("missedSchedule")
      ? "missedRun"
      : sources.has("providerTerminalFailed")
        ? "executionFailed"
        : "providerRoute";
  const updatedAtMs = projection.attention.reduce(
    (latest, item) => Math.max(
      latest,
      Number.isFinite(item.occurredAtMs) ? item.occurredAtMs : 0,
      Number.isFinite(item.aggregateUpdatedAtMs) ? item.aggregateUpdatedAtMs! : 0,
    ),
    0,
  );
  return {
    kind,
    count: Math.min(999, projection.attentionCount),
    updatedAtMs: updatedAtMs > 0 ? updatedAtMs : undefined,
  };
}

function projectionToRunHistory(
  record: TaskStoreRecord,
  projection: TaskStoreStateProjection,
  receipts: TaskStoreReceipt[],
): TaskRunHistoryEntry[] {
  const receiptsByOccurrence = new Map<string, TaskStoreReceipt[]>();
  for (const receipt of receipts) {
    const occurrenceId = receipt.execution?.occurrenceId
      ?? receipt.resultEvidence?.occurrenceId
      ?? receipt.traceEvidence?.occurrenceId;
    if (!occurrenceId) continue;
    const rows = receiptsByOccurrence.get(occurrenceId) ?? [];
    rows.push(receipt);
    receiptsByOccurrence.set(occurrenceId, rows);
  }
  return projection.runHistory.map((run) => {
    const runReceipts = receiptsByOccurrence.get(run.occurrenceId) ?? [];
    const claimedAtMs = runReceipts
      .filter((receipt) => receipt.kind === "occurrenceClaimed")
      .reduce<number | undefined>((first, receipt) => first === undefined ? receipt.occurredAtMs : Math.min(first, receipt.occurredAtMs), undefined);
    const timeline = runReceipts
      .map(receiptToTimeline)
      .filter((entry): entry is TaskRunTimelineEntry => Boolean(entry));
    const state: TaskRunHistoryEntry["state"] = run.state === "pending"
      ? "pending"
      : run.state === "running"
        ? "running"
        : run.state === "completed"
          ? "completed"
          : run.state === "outcomeUnknown"
            ? "outcomeUnknown"
            : "failed";
    const fresh = run.latestProviderDecision?.freshCatalogue;
    return {
      id: run.occurrenceId,
      state,
      attemptId: run.activeAttemptId,
      startedAtMs: claimedAtMs ?? run.scheduledAtMs,
      completedAtMs: state === "running" || state === "pending" ? undefined : run.updatedAtMs,
      conversationSessionId: run.conversationSessionId,
      traceEvidence: run.traceEvidence,
      resultEvidence: run.resultEvidence,
      receiptCount: runReceipts.length || undefined,
      environmentEvidence: {
        savedDefinitionSnapshot: {
          snapshotId: projection.savedEnvironment.snapshotId,
          capturedAtMs: record.revision.createdAtMs,
        },
        freshExecutionScan: fresh ? {
          snapshotId: fresh.snapshotId,
          generatedAtMs: fresh.generatedAtMs,
          freshUntilMs: fresh.freshUntilMs,
        } : undefined,
      },
      timeline,
    };
  });
}

function receiptToTimeline(receipt: TaskStoreReceipt): TaskRunTimelineEntry | undefined {
  if (receipt.kind === "occurrenceTraceEvidence") return {
    receiptId: receipt.receiptId,
    occurredAtMs: receipt.occurredAtMs,
    kind: "traceEvidence",
  };
  if (receipt.kind === "occurrenceResultEvidence") return {
    receiptId: receipt.receiptId,
    occurredAtMs: receipt.occurredAtMs,
    kind: "resultEvidence",
  };
  const execution = receipt.execution;
  if (!execution) return undefined;
  const decision = execution.providerDecision;
  let kind: TaskRunTimelineEntry["kind"];
  if (receipt.kind === "occurrenceCreated") kind = "occurrenceScheduled";
  else if (receipt.kind === "occurrenceClaimed") kind = "occurrenceClaimed";
  else if (receipt.kind === "occurrenceCompleted" || receipt.kind === "occurrenceOutcomeUnknown") kind = "terminal";
  else if (receipt.kind === "occurrenceProviderDecision" && decision?.stage === "committedStart") kind = "committedStart";
  else if (receipt.kind === "occurrenceProviderDecision" && decision?.stage === "terminal") kind = "terminal";
  else if (receipt.kind === "occurrenceProviderDecision") kind = "providerDecision";
  else if (receipt.kind === "notificationAttempted") kind = "notification";
  else return undefined;
  const provider = decision
    && Number.isInteger(decision.candidateOrder)
    && decision.candidateOrder! > 0
    && Boolean(decision.providerId?.trim())
    ? {
        providerId: decision.providerId!,
        candidateOrder: decision.candidateOrder!,
        verdict: decision.verdict,
        reason: providerReceiptReason(decision.reasonCode, decision.verdict),
      }
    : undefined;
  return {
    receiptId: receipt.receiptId,
    occurredAtMs: receipt.occurredAtMs,
    kind,
    provider,
    providerLifecycle: committedStartLifecycle(decision?.reasonCode),
  };
}

function committedStartLifecycle(reasonCode: string | undefined): TaskRunTimelineEntry["providerLifecycle"] {
  if (reasonCode === "providerAccepted") return "accepted";
  if (reasonCode === "providerActivity.providerRunning") return "running";
  if (reasonCode === "providerActivity.firstTaskContent") return "firstContent";
  return undefined;
}

function providerReceiptReason(
  reasonCode: string | undefined,
  verdict: TaskProviderReceiptVerdict,
): TaskProviderReceiptReason | undefined {
  if (verdict === "outcomeUnknown") return "outcomeUnknown";
  if (verdict === "failed") return "executionFailed";
  const normalized = reasonCode?.toLowerCase() ?? "";
  if (normalized.includes("rate") || normalized.includes("limit")) return "rateLimitedBeforeStart";
  if (normalized.includes("target") || normalized.includes("connection")) return "targetUnavailableBeforeStart";
  if (normalized.includes("incompatible") || normalized.includes("capability") || normalized.includes("model")) return "incompatibleBeforeStart";
  if (normalized.includes("approval") || normalized.includes("input")) return "operatorInputRequired";
  if (verdict === "rejectedPreEffect") return "unavailableBeforeStart";
  return undefined;
}

function receiptsToRunHistory(receipts: TaskStoreReceipt[]): TaskRunHistoryEntry[] {
  const byOccurrence = new Map<string, TaskStoreReceipt>();
  for (const receipt of receipts) {
    const occurrenceId = receipt.execution?.occurrenceId;
    if (occurrenceId) byOccurrence.set(occurrenceId, receipt);
  }
  return [...byOccurrence.values()].sort((left, right) => right.occurredAtMs - left.occurredAtMs).map((receipt) => {
    const execution = receipt.execution!;
    const verdict = execution.providerDecision?.verdict;
    const state: TaskRunHistoryEntry["state"] = receipt.kind === "occurrenceOutcomeUnknown" || verdict === "outcomeUnknown"
      ? "outcomeUnknown"
      : receipt.kind === "occurrenceCompleted" && verdict === "succeeded"
        ? "succeeded"
        : receipt.kind === "occurrenceCompleted" || verdict === "failed"
          ? "failed"
          : receipt.kind === "occurrenceClaimed" || receipt.kind === "occurrenceHeartbeat" || verdict === "started"
            ? "running"
            : "queued";
    return {
      id: execution.occurrenceId,
      state,
      startedAtMs: receipt.occurredAtMs,
      completedAtMs: state === "running" || state === "queued" ? undefined : receipt.occurredAtMs,
      summary: execution.providerDecision?.reasonCode ?? receipt.kind,
    };
  });
}

function toUiCandidate(candidate: TaskStoreRevision["candidates"][number]): TaskExecutionCandidate {
  return candidate.model.mode === "verifiedModel"
    ? { providerId: candidate.providerId, modelMode: "verifiedModel", modelId: candidate.model.modelId, order: candidate.order }
    : { providerId: candidate.providerId, modelMode: "providerDefault", order: candidate.order };
}

function taskProviderLabel(providerId: string): string {
  switch (providerId) {
    case "grok": return "Grok";
    case "codex-cli": return "Codex CLI";
    case "claude-code": return "Claude Code";
    case "antigravity-cli": return "Antigravity";
    default: return "Saved agent";
  }
}

function runtimeLabel(preset: ConnectionPreset): string {
  if (preset.transport.kind === "local") return "native";
  if (preset.transport.kind === "wsl") return "posix";
  if (preset.transport.kind === "ssh") return preset.transport.remoteRuntime ?? "posix";
  return "unsupported";
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
