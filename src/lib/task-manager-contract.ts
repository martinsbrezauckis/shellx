/**
 * Frontend boundary for the 0.3.6 Task Manager. These types deliberately
 * describe reviewed UI data, not CLI probes or provider authentication.
 */

export type TaskManagerMode = "create" | "edit";
export type TaskManagerState = "needsAttention" | "scheduled" | "running" | "paused" | "recent";
export type TaskManagerStateFilter = "all" | TaskManagerState;
export type TaskProviderAvailabilityStatus =
  | "checking"
  | "ready"
  | "missing"
  | "versionFailed"
  | "identityFailed"
  | "authNeeded"
  | "canaryFailed"
  | "targetUnavailable"
  | "stale"
  | "rateLimited";

export interface TaskEnvironmentOption {
  key: string;
  label: string;
  transport: string;
  runtime: string;
  projectLabel?: string;
  cwdLabel?: string;
}

export interface TaskProviderAvailability {
  status: TaskProviderAvailabilityStatus;
  canRun: boolean;
  detail: string;
  checkedAtMs?: number;
  version?: string;
}

export interface TaskProviderCapabilityGuidance {
  id: string;
  label: string;
  level: string;
  sourceCardIds: string[];
}

export interface TaskProviderModel {
  id: string;
  label: string;
  source: "providerNative";
  verifiedAtMs: number;
}

export interface TaskProviderCatalogueProvider {
  providerId: string;
  label: string;
  availability: TaskProviderAvailability;
  capabilityGuidance: TaskProviderCapabilityGuidance[];
  models: TaskProviderModel[];
  defaultModelMode: "providerDefault";
}

/** A target-bound projection of the authoritative connection provider scan. */
export interface TaskProviderCatalogue {
  schemaVersion: "shellx.task-provider-catalog.v1";
  /** Renderer-owned preset identity used to request this exact target scan. */
  environmentKey: string;
  /** `sha256:<64hex>` identity of the exact target-bound provider scan projection. */
  snapshotId: string;
  generatedAtMs: number;
  freshUntilMs: number;
  target: Pick<TaskEnvironmentOption, "key" | "label" | "transport" | "runtime">;
  providers: TaskProviderCatalogueProvider[];
}

export interface TaskProviderCatalogueState {
  state: "idle" | "checking" | "ready" | "error";
  detail?: string;
}

export interface TaskVaultGrantOption {
  grantId: string;
  keyId: string;
  operation: "fill" | "profileFill" | "emailCodeRead" | "agentWalletUse";
  origin?: string;
  expiresAtMs?: number;
}

export interface TaskVaultGrantState {
  state: "loading" | "ready" | "unavailable";
  detail?: string;
}

export interface TaskExecutionCandidate {
  providerId: string;
  modelMode: "providerDefault" | "verifiedModel";
  modelId?: string;
  order: number;
}

export type TaskWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface TaskLocalTime {
  hour: number;
  minute: number;
}

/** Mirrors the tagged `TaskTrigger` contract in the durable Task store. */
export type TaskTrigger =
  | { kind: "manual" }
  | { kind: "once"; atMs: number }
  | { kind: "daily"; at: TaskLocalTime }
  | { kind: "weekdays"; at: TaskLocalTime }
  | { kind: "weekly"; weekdays: TaskWeekday[]; at: TaskLocalTime }
  | { kind: "monthly"; day: number; at: TaskLocalTime };

export type TaskMissedRunPolicy = "skip" | "runOnceWhenAvailable" | "needsAttention";
export type TaskNotificationPolicy = "none" | "attentionOnly" | "everyTerminalResult";

export interface TaskSchedule {
  trigger: TaskTrigger;
  timezone: string;
  missedRunPolicy: TaskMissedRunPolicy;
  maxRunSeconds: number;
  notificationPolicy: TaskNotificationPolicy;
}

/**
 * A compact, renderer-safe projection of an occurrence. The aliases retained
 * below keep old store adapters readable while the coordinator moves to the
 * more explicit state names.
 */
export type TaskRunHistoryState =
  | "queued"
  | "pending"
  | "running"
  | "succeeded"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcomeUnknown"
  | "missedNeedsAttention";

/** User-facing attention categories. Do not put provider output or diagnostics here. */
export type TaskAttentionKind =
  | "outcomeUnknown"
  | "missedRun"
  | "providerRoute"
  | "approvalRequired"
  | "executionFailed";

/**
 * Bounded task-level attention metadata. `count` is occurrence-based, so a
 * header may safely sum it without inspecting receipt bodies.
 */
export interface TaskAttentionState {
  kind: TaskAttentionKind;
  count: number;
  updatedAtMs?: number;
}

export type TaskAttentionSource =
  | "missedSchedule"
  | "occurrenceOutcomeUnknown"
  | "providerTerminalFailed"
  | "providerTerminalOutcomeUnknown"
  | "attentionLedgerSaturated";

/** Exact, renderer-safe CAS fields for one explicit acknowledgement. */
export interface TaskAttentionActionItem {
  attentionId: string;
  source: TaskAttentionSource;
  occurrenceId?: string;
  revisionId: string;
  openedAtMs: number;
  aggregateOmittedCount?: number;
  aggregateUpdatedAtMs?: number;
}

export type TaskProviderReceiptVerdict =
  | "eligible"
  | "rejectedPreEffect"
  | "selected"
  | "started"
  | "succeeded"
  | "failed"
  | "outcomeUnknown";

/**
 * Deliberately coarse reason classes for a provider-route receipt. The
 * renderer maps these to fixed copy; it never displays provider output,
 * authentication material, filesystem paths, or hidden probe diagnostics.
 */
export type TaskProviderReceiptReason =
  | "unavailableBeforeStart"
  | "incompatibleBeforeStart"
  | "rateLimitedBeforeStart"
  | "targetUnavailableBeforeStart"
  | "operatorInputRequired"
  | "executionFailed"
  | "outcomeUnknown";

export interface TaskProviderTimelineReceipt {
  providerId: string;
  candidateOrder: number;
  verdict: TaskProviderReceiptVerdict;
  reason?: TaskProviderReceiptReason;
}

export type TaskRunTimelineKind =
  | "occurrenceScheduled"
  | "occurrenceClaimed"
  | "providerDecision"
  | "committedStart"
  | "terminal"
  | "traceEvidence"
  | "resultEvidence"
  | "missedNeedsAttention"
  | "notification";

/**
 * One append-only receipt projection. The opaque receipt ID supports support
 * correlation but is intentionally not rendered in the task workspace.
 */
export interface TaskRunTimelineEntry {
  receiptId: string;
  occurredAtMs: number;
  kind: TaskRunTimelineKind;
  provider?: TaskProviderTimelineReceipt;
  providerLifecycle?: "accepted" | "running" | "firstContent";
}

/**
 * Distinguishes immutable definition provenance from the fresh scan that
 * authorizes a particular execution. Snapshot identities are opaque and stay
 * out of the UI; the display makes their distinct roles explicit.
 */
export interface TaskRunEnvironmentEvidence {
  savedDefinitionSnapshot?: {
    snapshotId: string;
    capturedAtMs?: number;
  };
  freshExecutionScan?: {
    snapshotId: string;
    generatedAtMs: number;
    freshUntilMs: number;
  };
}

export type TaskRunResultEvidenceState = "complete" | "incomplete" | "noBrowserActivity";
export type TaskRunResultEvidenceKind = "browserFlightRecorder" | "browserEvaluation";

export interface TaskRunResultEvidenceIdentity {
  kind: TaskRunResultEvidenceKind;
  evidenceId: string;
  artifactSha256: string;
  evidenceDigest?: string;
  browserReceiptId: string;
  evidenceComplete: boolean;
  createdAtMs: number;
}

/** Path-free Browser evidence identities bound to this exact terminal run. */
export interface TaskRunResultEvidence {
  state: TaskRunResultEvidenceState;
  browserTaskCount: number;
  exportedBrowserTaskCount: number;
  recorderCount: number;
  evaluationCount: number;
  identities: TaskRunResultEvidenceIdentity[];
  recordedAtMs: number;
}

export interface TaskRunTraceEvidence {
  state: "complete" | "incomplete" | "noProviderActivity";
  archiveSha256?: string;
  archiveBytes: number;
  recordCount: number;
  providerEventCount: number;
  droppedEventCount: number;
  terminalMarkerPresent: boolean;
  recoveredAfterRestart: boolean;
  recordedAtMs: number;
}

export interface TaskRunHistoryEntry {
  id: string;
  /** Exact active attempt identity required for a stale-safe cancellation. */
  attemptId?: string;
  /** Exact private conversation proven reviewable by its Trace receipt. */
  conversationSessionId?: string;
  state: TaskRunHistoryState;
  startedAtMs?: number;
  completedAtMs?: number;
  /**
   * Compatibility only. New adapters must use `timeline`; this unstructured
   * value is never rendered because it may contain backend diagnostics.
   */
  summary?: string;
  /** Compatibility only. Never render unstructured disabled details. */
  disabledReason?: string;
  receiptCount?: number;
  environmentEvidence?: TaskRunEnvironmentEvidence;
  traceEvidence?: TaskRunTraceEvidence;
  resultEvidence?: TaskRunResultEvidence;
  timeline?: TaskRunTimelineEntry[];
}

export interface TaskDefinitionSummary {
  id: string;
  revisionId: string;
  /** Exact immutable revision SHA-256 required by T1's revise CAS. */
  revisionHash: string;
  name: string;
  instructionPreview: string;
  state: TaskManagerState;
  enabled: boolean;
  environmentKey: string;
  environmentLabel: string;
  projectLabel?: string;
  providerIds: string[];
  providerRouteSummary: string;
  scheduleSummary: string;
  updatedAtMs: number;
  /** Safe, typed attention state for badges, titles, and filtering. */
  attention?: TaskAttentionState;
  /**
   * Compatibility only. New adapters must emit `attention`; UI must never
   * render or search this unstructured value.
   */
  attentionReason?: string;
}

export interface TaskDefinitionDetail extends TaskDefinitionSummary {
  instruction: string;
  successCriteria?: string;
  candidates: TaskExecutionCandidate[];
  schedule: TaskSchedule;
  permissionSummary: string;
  notificationSummary: string;
  workflowSummary?: string;
  vaultSummary?: string;
  runHistory: TaskRunHistoryEntry[];
  attentionItems: TaskAttentionActionItem[];
  /**
   * Adapter-owned durable metadata for a revision. It is not rendered as a
   * provider route and lets an edit retain fields that Task Manager does not
   * currently expose as form controls.
   */
  draftContext?: TaskManagerDraftContext;
}

/**
 * Reviewed provenance and execution-policy context captured beside a chat.
 * Attachment references intentionally contain durable IDs only: never a
 * renderer path, a composer-chip ID, file contents, or a Vault value.
 */
export interface TaskManagerDraftContext {
  /** Logical saved-preset identity. This is distinct from a scanned target key. */
  connectionKey: string;
  canonicalCwd: string;
  projectId?: string;
  agentSuggestion?: string;
  permissionMode: string;
  autonomyMode: string;
  toolExposureIds: string[];
  attachmentRefs: Array<{ attachmentId: string; digest?: string }>;
  origin?: { sessionId?: string; tabId?: string };
  /** Durable fields retained while the current Task Manager UI does not edit them. */
  noChangeCriteria?: string;
  workflow?: { workflowId: string; digest: string };
  vaultRequirements?: Array<{ keyId: string; grantId?: string }>;
  concurrencyPolicy?: { maxActiveRuns: number };
  retryPolicy?: { maxAttempts: number; idempotentObservationOnly: boolean };
  retentionPolicy?: { maxReceipts: number };
  candidateMetadata?: Record<string, {
    capabilityRequirements: string[];
    optionRefs: Array<{ optionId: string; referenceId: string }>;
  }>;
}

/**
 * `originRequestId` and `originRevision` are required to make a composer
 * handoff replace, rather than accidentally retain, an already-mounted draft.
 */
export interface TaskManagerDraft {
  originRequestId: string;
  originRevision: number;
  taskId?: string;
  revisionId?: string;
  revisionHash?: string;
  name: string;
  instruction: string;
  successCriteria?: string;
  environmentKey: string;
  schedule: TaskSchedule;
  enabled: boolean;
  candidates: TaskExecutionCandidate[];
  /** Composer provenance and retained durable fields; Task Manager never treats this as a route. */
  context?: TaskManagerDraftContext;
}

export interface TaskManagerData {
  loadState: "loading" | "ready" | "empty" | "error";
  loadDetail?: string;
  environments: TaskEnvironmentOption[];
  providerCatalogue?: TaskProviderCatalogue;
  providerCatalogueState: TaskProviderCatalogueState;
  vaultGrantOptions?: TaskVaultGrantOption[];
  vaultGrantState?: TaskVaultGrantState;
  definitions: TaskDefinitionSummary[];
  selectedDefinitionId?: string;
  selectedDefinition?: TaskDefinitionDetail;
}

export interface TaskManagerActionResult {
  accepted: boolean;
  detail?: string;
  disabledReason?: string;
}

export interface TaskProviderCatalogueRequest {
  environmentKey: string;
  reason: "createOpened" | "environmentChanged" | "savePreflight" | "runPreflight" | "manualRecheck";
}

export interface TaskRunRequest {
  definitionId: string;
  revisionId: string;
  revisionHash: string;
}

export interface TaskPauseRequest {
  definitionId: string;
  revisionId: string;
  action: "pause" | "resume";
}

export interface TaskDuplicateRequest {
  definitionId: string;
  revisionId: string;
}

export interface TaskDeleteRequest {
  definitionId: string;
  revisionId: string;
}

export interface TaskOpenRunRequest {
  definitionId: string;
  conversationSessionId: string;
}

export interface TaskResolveAttentionRequest {
  definitionId: string;
  attentionId: string;
  expectedOpenedAtMs: number;
  aggregateOmittedCount?: number;
  aggregateUpdatedAtMs?: number;
}

export interface TaskCancelRunRequest {
  definitionId: string;
  occurrenceId: string;
  attemptId: string;
}

export function isTaskProviderCatalogueFresh(
  catalogue: TaskProviderCatalogue | undefined,
  environmentKey: string,
  nowMs = Date.now(),
): boolean {
  return Boolean(
    catalogue
      && isSha256Id(catalogue.snapshotId)
      && catalogue.environmentKey === environmentKey
      && Boolean(catalogue.target.key.trim())
      && catalogue.freshUntilMs > nowMs,
  );
}

export function providerStatusLabel(status: TaskProviderAvailabilityStatus): string {
  switch (status) {
    case "checking": return "Checking";
    case "ready": return "Ready";
    case "missing": return "Missing";
    case "versionFailed": return "Version failed";
    case "identityFailed": return "Identity failed";
    case "authNeeded": return "Auth needed";
    case "canaryFailed": return "Canary failed";
    case "targetUnavailable": return "Target unavailable";
    case "stale": return "Stale";
    case "rateLimited": return "Rate limited";
  }
}

export function taskStateLabel(state: TaskManagerState): string {
  switch (state) {
    case "needsAttention": return "Needs attention";
    case "scheduled": return "Scheduled";
    case "running": return "Running";
    case "paused": return "Paused";
    case "recent": return "Recent";
  }
}

export function normalizeTaskCandidates(candidates: TaskExecutionCandidate[]): TaskExecutionCandidate[] {
  const seen = new Set<string>();
  const normalized: TaskExecutionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.providerId.trim() || seen.has(candidate.providerId)) continue;
    seen.add(candidate.providerId);
    normalized.push({
      providerId: candidate.providerId,
      modelMode: candidate.modelMode,
      ...(candidate.modelMode === "verifiedModel" && candidate.modelId?.trim()
        ? { modelId: candidate.modelId }
        : {}),
      order: normalized.length + 1,
    });
  }
  return normalized;
}

/**
 * Keep selected providers in their actual fallback order, then show the
 * remaining available choices in catalogue order. A provider catalogue is an
 * availability projection, not the user's execution route, so its ordering
 * must never visually contradict the numbered route.
 */
export function taskProvidersForDisplay(
  providers: TaskProviderCatalogueProvider[],
  candidates: TaskExecutionCandidate[],
): TaskProviderCatalogueProvider[] {
  const active = normalizeTaskCandidates(candidates);
  const providersById = new Map(providers.map((provider) => [provider.providerId, provider]));
  const activeIds = new Set(active.map((candidate) => candidate.providerId));
  return [
    ...active.flatMap((candidate) => {
      const provider = providersById.get(candidate.providerId);
      return provider ? [provider] : [];
    }),
    ...providers.filter((provider) => !activeIds.has(provider.providerId)),
  ];
}

export function providerEditorDisabledReason(
  draft: Pick<TaskManagerDraft, "environmentKey">,
  data: Pick<TaskManagerData, "providerCatalogue" | "providerCatalogueState">,
  nowMs = Date.now(),
): string | undefined {
  if (!draft.environmentKey) return "Select an environment before choosing an agent.";
  if (data.providerCatalogueState.state === "checking") return "Checking which agents are available in the selected environment.";
  if (data.providerCatalogueState.state === "error") return data.providerCatalogueState.detail || "Agent availability could not be checked.";
  if (!data.providerCatalogue) return "Agent availability has not been checked for this environment.";
  if (data.providerCatalogue.environmentKey !== draft.environmentKey) {
    return `These availability results belong to ${data.providerCatalogue.target.label}; recheck the selected environment.`;
  }
  if (!isTaskProviderCatalogueFresh(data.providerCatalogue, draft.environmentKey, nowMs)) {
    return "Agent availability is out of date; recheck before changing the order.";
  }
  return undefined;
}

/**
 * A fresh catalogue is still evidence when a provider is unavailable. Paused
 * definitions may deliberately retain that route for a later resume; enabled
 * definitions may only add providers that are ready at the selected target.
 */
export function taskProviderSelectionDisabledReason(
  draft: Pick<TaskManagerDraft, "environmentKey" | "enabled">,
  data: Pick<TaskManagerData, "providerCatalogue" | "providerCatalogueState">,
  providerId: string,
  alreadySelected: boolean,
  nowMs = Date.now(),
): string | undefined {
  const editorReason = providerEditorDisabledReason(draft, data, nowMs);
  if (editorReason) return editorReason;
  const provider = data.providerCatalogue!.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) return "This agent is no longer present in the latest availability check.";
  if (alreadySelected || !draft.enabled) return undefined;
  if (provider.availability.status === "ready" && provider.availability.canRun) return undefined;
  return `${provider.label} is not currently ready. Pause the task to keep this route for later.`;
}

/** Run-now is always bound to fresh availability, unlike a paused definition. */
export function taskReadyProviderRouteDisabledReason(
  draft: Pick<TaskManagerDraft, "environmentKey" | "candidates">,
  data: Pick<TaskManagerData, "providerCatalogue" | "providerCatalogueState">,
  nowMs = Date.now(),
): string | undefined {
  const editorReason = providerEditorDisabledReason(draft, data, nowMs);
  if (editorReason) return editorReason;
  const readyProviderIds = new Set(
    data.providerCatalogue!.providers
      .filter((provider) => provider.availability.status === "ready" && provider.availability.canRun)
      .map((provider) => provider.providerId),
  );
  if (!draft.candidates.some((candidate) => readyProviderIds.has(candidate.providerId))) {
    return "Run now requires at least one currently ready agent.";
  }
  return undefined;
}

export function taskSaveDisabledReason(
  draft: TaskManagerDraft,
  data: Pick<TaskManagerData, "providerCatalogue" | "providerCatalogueState" | "vaultGrantOptions">,
  nowMs = Date.now(),
): string | undefined {
  if (!draft.name.trim()) return "Enter a task name before saving.";
  if (!draft.instruction.trim()) return "Enter an instruction before saving.";
  if (draft.taskId && !draft.revisionHash?.trim()) {
    return "The selected task revision has no hash; reload it before saving.";
  }
  if (draft.taskId && !isCanonicalRevisionHash(draft.revisionHash!)) {
    return "The selected task revision hash is invalid; reload it before saving.";
  }
  if (!draft.environmentKey) return "Select an environment before saving.";
  const attachments = draft.context?.attachmentRefs ?? [];
  if (attachments.length > 16
    || new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length
    || attachments.some((attachment) => !/^task-attachment:v1:[a-f0-9]{64}$/.test(attachment.attachmentId)
      || !attachment.digest || !/^sha256:[a-f0-9]{64}$/.test(attachment.digest))) {
    return "Replace or remove invalid durable attachment references before saving.";
  }
  const scheduleReason = taskScheduleValidationReason(draft.schedule, nowMs);
  if (scheduleReason) return scheduleReason;
  if (normalizeTaskCandidates(draft.candidates).length === 0) {
    return "Choose at least one agent before saving.";
  }
  if (!draft.enabled) return undefined;
  const vaultRequirements = draft.context?.vaultRequirements ?? [];
  const activeVaultGrants = new Set((data.vaultGrantOptions ?? []).map((grant) => `${grant.keyId}\u0000${grant.grantId}`));
  if (vaultRequirements.some((requirement) => {
    const grantId = requirement.grantId?.trim();
    return !grantId || !activeVaultGrants.has(`${requirement.keyId}\u0000${grantId}`);
  })) {
    return "Enable requires an active mediated Vault grant for every reviewed Vault key.";
  }
  const editorReason = providerEditorDisabledReason(draft, data, nowMs);
  if (editorReason) return editorReason;
  const readyProviderIds = new Set(
    data.providerCatalogue?.providers
      .filter((provider) => provider.availability.status === "ready" && provider.availability.canRun)
      .map((provider) => provider.providerId),
  );
  if (!draft.candidates.some((candidate) => readyProviderIds.has(candidate.providerId))) {
    return "Enable requires at least one currently ready agent.";
  }
  return undefined;
}

export function createTaskManagerDraft(
  source: TaskManagerDraft,
  overrides: Partial<TaskManagerDraft> = {},
): TaskManagerDraft {
  return {
    ...source,
    ...overrides,
    candidates: normalizeTaskCandidates(overrides.candidates ?? source.candidates),
  };
}

const TASK_WEEKDAY_ORDER: TaskWeekday[] = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];
const TASK_TIMEZONE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;

/** Returns the scheduling timezone owned by the computer running ShellX. */
export function taskDeviceTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return timezone && timezone.length <= 256 && TASK_TIMEZONE_PATTERN.test(timezone) ? timezone : "UTC";
  } catch {
    return "UTC";
  }
}

export function normalizeTaskSchedule(schedule: TaskSchedule): TaskSchedule {
  const timezone = schedule.timezone.trim();
  if (!timezone || timezone.length > 256 || !TASK_TIMEZONE_PATTERN.test(timezone)) {
    throw new Error("Enter a valid timezone identifier before saving.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    throw new Error("Choose a timezone supported by this computer before saving.");
  }
  if (!Number.isInteger(schedule.maxRunSeconds) || schedule.maxRunSeconds <= 0) {
    throw new Error("Stop-after duration must be at least 1 minute.");
  }
  if (!isMissedRunPolicy(schedule.missedRunPolicy)) throw new Error("Choose a supported missed-run policy.");
  if (!isNotificationPolicy(schedule.notificationPolicy)) throw new Error("Choose a supported notification policy.");
  return {
    ...schedule,
    timezone,
    trigger: normalizeTaskTrigger(schedule.trigger),
  };
}

export function taskScheduleValidationReason(schedule: TaskSchedule, nowMs = Date.now()): string | undefined {
  try {
    const normalized = normalizeTaskSchedule(schedule);
    if (normalized.trigger.kind === "once" && normalized.trigger.atMs <= nowMs) {
      return "Choose a future date and time for a one-time task.";
    }
  } catch (error) {
    return error instanceof Error ? error.message : "The schedule is invalid.";
  }
  return undefined;
}

export function taskScheduleSummary(schedule: TaskSchedule): string {
  const normalized = normalizeTaskSchedule(schedule);
  switch (normalized.trigger.kind) {
    case "manual": return "Manual only";
    case "once": return `Once on ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(normalized.trigger.atMs))}`;
    case "daily": return `Every day at ${formatTaskLocalTime(normalized.trigger.at)}`;
    case "weekdays": return `Weekdays at ${formatTaskLocalTime(normalized.trigger.at)}`;
    case "weekly": return `Every ${normalized.trigger.weekdays.map(weekdayLabel).join(", ")} at ${formatTaskLocalTime(normalized.trigger.at)}`;
    case "monthly": return `Every month on day ${normalized.trigger.day} at ${formatTaskLocalTime(normalized.trigger.at)}`;
  }
}

export function formatTaskLocalTime(value: TaskLocalTime): string {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

export function parseTaskLocalTime(value: string): TaskLocalTime | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return isValidTaskLocalTime({ hour, minute }) ? { hour, minute } : undefined;
}

function normalizeTaskTrigger(trigger: TaskTrigger): TaskTrigger {
  switch (trigger.kind) {
    case "manual": return { kind: "manual" };
    case "once":
      if (!Number.isSafeInteger(trigger.atMs) || trigger.atMs <= 0 || Number.isNaN(new Date(trigger.atMs).getTime())) {
        throw new Error("Once schedules need a valid date and time.");
      }
      return { kind: "once", atMs: trigger.atMs };
    case "daily": return { kind: "daily", at: normalizeTaskLocalTime(trigger.at) };
    case "weekdays": return { kind: "weekdays", at: normalizeTaskLocalTime(trigger.at) };
    case "weekly": {
      if (trigger.weekdays.length !== new Set(trigger.weekdays).size) {
        throw new Error("Weekly schedule weekdays must be unique.");
      }
      const weekdays = [...new Set(trigger.weekdays)].sort((left, right) => TASK_WEEKDAY_ORDER.indexOf(left) - TASK_WEEKDAY_ORDER.indexOf(right));
      if (weekdays.length === 0 || weekdays.some((weekday) => !TASK_WEEKDAY_ORDER.includes(weekday))) {
        throw new Error("Weekly schedules need at least one valid weekday.");
      }
      return { kind: "weekly", weekdays, at: normalizeTaskLocalTime(trigger.at) };
    }
    case "monthly": {
      if (!Number.isInteger(trigger.day) || trigger.day < 1 || trigger.day > 31) {
        throw new Error("Monthly schedules need a day from 1 through 31.");
      }
      return { kind: "monthly", day: trigger.day, at: normalizeTaskLocalTime(trigger.at) };
    }
  }
}

function normalizeTaskLocalTime(value: TaskLocalTime): TaskLocalTime {
  if (!isValidTaskLocalTime(value)) throw new Error("Schedule time must be a valid 24-hour local time.");
  return { hour: value.hour, minute: value.minute };
}

function isValidTaskLocalTime(value: TaskLocalTime): boolean {
  return Number.isInteger(value.hour) && Number.isInteger(value.minute) && value.hour >= 0 && value.hour < 24 && value.minute >= 0 && value.minute < 60;
}

function isMissedRunPolicy(value: string): value is TaskMissedRunPolicy {
  return value === "skip" || value === "runOnceWhenAvailable" || value === "needsAttention";
}

function isNotificationPolicy(value: string): value is TaskNotificationPolicy {
  return value === "none" || value === "attentionOnly" || value === "everyTerminalResult";
}

function weekdayLabel(value: TaskWeekday): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1, 3);
}

function isSha256Id(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isCanonicalRevisionHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
