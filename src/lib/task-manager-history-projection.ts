import type {
  TaskAttentionKind,
  TaskAttentionState,
  TaskDefinitionSummary,
  TaskProviderReceiptReason,
  TaskProviderReceiptVerdict,
  TaskRunHistoryEntry,
  TaskRunHistoryState,
  TaskRunTimelineEntry,
} from "./task-manager-contract";

/** The inspector intentionally stays compact even when a task retained many receipts. */
export const MAX_TASK_TIMELINE_ENTRIES = 12;

export interface TaskAttentionPresentation {
  count: number;
  title: string;
  detail: string;
}

export interface TaskRunStatePresentation {
  label: string;
  tone: "neutral" | "active" | "success" | "attention" | "muted";
}

export interface TaskTimelinePresentation {
  label: string;
  detail: string;
  tone: "neutral" | "active" | "success" | "attention" | "muted";
}

export interface TaskEnvironmentReceiptPresentation {
  kind: "savedDefinitionSnapshot" | "freshExecutionScan";
  label: string;
  detail: string;
  occurredAtMs?: number;
}

export interface TaskTraceEvidencePresentation {
  label: string;
  detail: string;
  occurredAtMs?: number;
}

export interface TaskResultEvidencePresentation {
  label: string;
  detail: string;
  occurredAtMs?: number;
}

/**
 * Normalizes the one small, safe attention projection used by Task Manager
 * and the header badge. Existing untyped `attentionReason` text is ignored.
 */
export function taskAttentionPresentation(
  definition: Pick<TaskDefinitionSummary, "state" | "attention">,
): TaskAttentionPresentation | undefined {
  const attention = normalizedAttention(definition.attention, definition.state);
  if (!attention) return undefined;
  const copy = attentionCopy(attention.kind);
  return { count: attention.count, ...copy };
}

/** Counts unresolved occurrences, not definitions. The Header applies its 9+ visual cap. */
export function taskAttentionCount(definitions: ReadonlyArray<Pick<TaskDefinitionSummary, "state" | "attention">>): number {
  return definitions.reduce((total, definition) => {
    const attention = normalizedAttention(definition.attention, definition.state);
    return attention ? Math.min(999, total + attention.count) : total;
  }, 0);
}

export function taskRunStatePresentation(state: TaskRunHistoryState): TaskRunStatePresentation {
  switch (state) {
    case "queued":
    case "pending": return { label: "Pending", tone: "neutral" };
    case "running": return { label: "Running", tone: "active" };
    case "succeeded":
    case "completed": return { label: "Completed", tone: "success" };
    case "failed": return { label: "Failed", tone: "attention" };
    case "cancelled": return { label: "Cancelled", tone: "muted" };
    case "outcomeUnknown": return { label: "Outcome unknown", tone: "attention" };
    case "missedNeedsAttention": return { label: "Missed · needs attention", tone: "attention" };
  }
}

/** Returns verified-shaped receipt rows in chronological order and bounds the rendered list. */
export function taskTimelineForDisplay(run: Pick<TaskRunHistoryEntry, "timeline">): TaskRunTimelineEntry[] {
  return (run.timeline ?? [])
    .filter(isDisplayableTimelineEntry)
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.receiptId.localeCompare(right.receiptId))
    .slice(-MAX_TASK_TIMELINE_ENTRIES);
}

/** Fixed copy prevents receipt diagnostics or provider output from becoming UI text. */
export function taskTimelinePresentation(entry: TaskRunTimelineEntry): TaskTimelinePresentation {
  switch (entry.kind) {
    case "occurrenceScheduled": return { label: "Occurrence scheduled", detail: "Waiting for its configured time.", tone: "neutral" };
    case "occurrenceClaimed": return { label: "Occurrence claimed", detail: "ShellX recorded one active attempt.", tone: "active" };
    case "committedStart": return committedStartPresentation(entry.providerLifecycle);
    case "terminal": return terminalPresentation(entry.provider?.verdict);
    case "traceEvidence": return { label: "Conversation evidence recorded", detail: "An output-free receipt binds the private ShellX conversation to this occurrence.", tone: "success" };
    case "resultEvidence": return { label: "Result evidence recorded", detail: "Path-free Browser artifact identities are bound to this occurrence.", tone: "success" };
    case "missedNeedsAttention": return { label: "Missed occurrence needs review", detail: "The task stayed paused from automatic execution until reviewed.", tone: "attention" };
    case "notification": return { label: "Notification recorded", detail: "This follows the task’s selected notification preference.", tone: "neutral" };
    case "providerDecision": return providerDecisionPresentation(entry);
  }
}

function committedStartPresentation(lifecycle: TaskRunTimelineEntry["providerLifecycle"]): TaskTimelinePresentation {
  if (lifecycle === "accepted") return { label: "Agent accepted task", detail: "Automatic agent fallback is now closed for this occurrence.", tone: "active" };
  if (lifecycle === "running") return { label: "Agent is running", detail: "The selected agent reported active work.", tone: "active" };
  if (lifecycle === "firstContent") return { label: "First response received", detail: "The task conversation has started returning content.", tone: "active" };
  return { label: "Task work started", detail: "Automatic agent fallback is now closed for this occurrence.", tone: "active" };
}

/**
 * The saved revision snapshot proves what the task was defined against. A
 * fresh execution scan is separate, current evidence used before a run.
 */
export function taskEnvironmentReceiptPresentation(
  run: Pick<TaskRunHistoryEntry, "environmentEvidence">,
): TaskEnvironmentReceiptPresentation[] {
  const evidence = run.environmentEvidence;
  if (!evidence) return [];
  const rows: TaskEnvironmentReceiptPresentation[] = [];
  if (evidence.savedDefinitionSnapshot?.snapshotId.trim()) {
    rows.push({
      kind: "savedDefinitionSnapshot",
      label: "Saved definition environment",
      detail: "Bound to the immutable task revision.",
      occurredAtMs: finiteTimestamp(evidence.savedDefinitionSnapshot.capturedAtMs),
    });
  }
  if (evidence.freshExecutionScan?.snapshotId.trim()) {
    rows.push({
      kind: "freshExecutionScan",
      label: "Fresh execution scan",
      detail: "Checked again immediately before this occurrence.",
      occurredAtMs: finiteTimestamp(evidence.freshExecutionScan.generatedAtMs),
    });
  }
  return rows;
}

/** Fixed-copy summary of path-free Browser evidence bound to one exact run. */
export function taskResultEvidencePresentation(
  run: Pick<TaskRunHistoryEntry, "resultEvidence">,
): TaskResultEvidencePresentation | undefined {
  const evidence = run.resultEvidence;
  if (!evidence) return undefined;
  if (evidence.state === "noBrowserActivity") {
    return {
      label: "Browser result evidence",
      detail: "No Task-owned Browser activity was recorded for this run.",
      occurredAtMs: finiteTimestamp(evidence.recordedAtMs),
    };
  }
  if (evidence.state === "incomplete") {
    const taskCount = boundedCount(evidence.browserTaskCount);
    return {
      label: "Browser result evidence has gaps",
      detail: `${boundedCount(evidence.exportedBrowserTaskCount)} of ${taskCount} Browser task${taskCount === 1 ? "" : "s"} exported.`,
      occurredAtMs: finiteTimestamp(evidence.recordedAtMs),
    };
  }
  const recorderCount = boundedCount(evidence.recorderCount);
  const evaluationCount = boundedCount(evidence.evaluationCount);
  const evaluation = evaluationCount > 0
    ? ` and ${evaluationCount} evaluation${evaluationCount === 1 ? "" : "s"}`
    : "";
  return {
    label: "Browser result evidence recorded",
    detail: `${recorderCount} Flight Recorder bundle${recorderCount === 1 ? "" : "s"}${evaluation} bound to this run.`,
    occurredAtMs: finiteTimestamp(evidence.recordedAtMs),
  };
}

/** Fixed-copy summary of the output-free private conversation receipt. */
export function taskTraceEvidencePresentation(
  run: Pick<TaskRunHistoryEntry, "traceEvidence">,
): TaskTraceEvidencePresentation | undefined {
  const evidence = run.traceEvidence;
  if (!evidence) return undefined;
  const occurredAtMs = finiteTimestamp(evidence.recordedAtMs);
  if (evidence.state === "noProviderActivity") {
    return {
      label: "Task conversation recorded",
      detail: "The run archive contains its prompt and terminal receipt with no provider stream activity.",
      occurredAtMs,
    };
  }
  if (evidence.state === "incomplete") {
    return {
      label: "Task conversation has gaps",
      detail: evidence.recoveredAfterRestart
        ? "A reviewable private archive was recovered after restart; stream completeness is intentionally unclaimed."
        : "The private archive remains reviewable where available, with dropped or unverified stream records disclosed.",
      occurredAtMs,
    };
  }
  const eventCount = boundedCount(evidence.providerEventCount);
  return {
    label: "Task conversation recorded",
    detail: `${eventCount} provider event${eventCount === 1 ? "" : "s"} bound to this exact run.`,
    occurredAtMs,
  };
}

function boundedCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 999) : 0;
}

export function formatTaskReceiptTime(value: number | undefined): string | undefined {
  if (!Number.isFinite(value) || value! <= 0) return undefined;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value!));
}

function normalizedAttention(attention: TaskAttentionState | undefined, state: TaskDefinitionSummary["state"]): TaskAttentionState | undefined {
  if (attention && Number.isInteger(attention.count) && attention.count > 0) {
    return { ...attention, count: Math.min(attention.count, 999) };
  }
  return state === "needsAttention" ? { kind: "executionFailed", count: 1 } : undefined;
}

function attentionCopy(kind: TaskAttentionKind): Omit<TaskAttentionPresentation, "count"> {
  switch (kind) {
    case "outcomeUnknown": return { title: "Outcome unknown", detail: "Review this occurrence before starting any replacement work." };
    case "missedRun": return { title: "Missed occurrence needs review", detail: "Review the schedule and receipt timeline before resuming it." };
    case "providerRoute": return { title: "Agent choice needs review", detail: "Review the recorded agent decisions before changing the task." };
    case "approvalRequired": return { title: "Task is waiting for review", detail: "An occurrence is waiting for an operator decision." };
    case "executionFailed": return { title: "Task needs review", detail: "Review the receipt timeline before the next occurrence." };
  }
}

function providerDecisionPresentation(entry: TaskRunTimelineEntry): TaskTimelinePresentation {
  const provider = entry.provider;
  if (!provider) return { label: "Agent choice checked", detail: "An agent decision was recorded.", tone: "neutral" };
  const route = `Choice ${provider.candidateOrder} · ${providerLabel(provider.providerId)}`;
  switch (provider.verdict) {
    case "eligible": return { label: `${route} available`, detail: "This agent was ready before task work began.", tone: "neutral" };
    case "rejectedPreEffect": return { label: `${route} skipped before work`, detail: providerReasonCopy(provider.reason), tone: "muted" };
    case "selected": return { label: `${route} selected`, detail: "ShellX selected this saved agent for the run.", tone: "active" };
    case "started": return { label: `${route} started`, detail: "ShellX will not start another agent for this run.", tone: "active" };
    case "succeeded": return { label: `${route} completed`, detail: "The terminal receipt recorded a completed occurrence.", tone: "success" };
    case "failed": return { label: `${route} needs review`, detail: providerReasonCopy(provider.reason), tone: "attention" };
    case "outcomeUnknown": return { label: `${route} outcome unknown`, detail: "ShellX stopped automatic fallback and kept this occurrence for review.", tone: "attention" };
  }
}

function terminalPresentation(verdict: TaskProviderReceiptVerdict | undefined): TaskTimelinePresentation {
  if (verdict === "succeeded") return { label: "Occurrence completed", detail: "The terminal receipt recorded completion.", tone: "success" };
  if (verdict === "outcomeUnknown") return { label: "Outcome unknown", detail: "ShellX preserved the occurrence for review instead of retrying it automatically.", tone: "attention" };
  if (verdict === "failed") return { label: "Occurrence needs review", detail: "The terminal receipt recorded a reviewable result.", tone: "attention" };
  return { label: "Occurrence finished", detail: "A terminal receipt was recorded.", tone: "neutral" };
}

function providerReasonCopy(reason: TaskProviderReceiptReason | undefined): string {
  switch (reason) {
    case "unavailableBeforeStart": return "This agent was unavailable before task work began.";
    case "incompatibleBeforeStart": return "This agent did not match the task before work began.";
    case "rateLimitedBeforeStart": return "This agent could not start before task work began.";
    case "targetUnavailableBeforeStart": return "The selected environment was unavailable before task work began.";
    case "operatorInputRequired": return "This occurrence is waiting for an operator decision.";
    case "executionFailed": return "The occurrence needs review before any replacement work.";
    case "outcomeUnknown": return "The outcome is unknown, so ShellX did not start another provider.";
    default: return "This agent was not started; ShellX may check the next saved choice.";
  }
}

function providerLabel(providerId: string): string {
  switch (providerId) {
    case "grok": return "Grok";
    case "codex-cli": return "Codex CLI";
    case "claude-code": return "Claude Code";
    case "antigravity": return "Antigravity";
    default: return "Saved agent";
  }
}

function isDisplayableTimelineEntry(entry: TaskRunTimelineEntry): boolean {
  return Boolean(entry.receiptId.trim())
    && Number.isFinite(entry.occurredAtMs)
    && entry.occurredAtMs > 0
    && ["occurrenceScheduled", "occurrenceClaimed", "providerDecision", "committedStart", "terminal", "traceEvidence", "resultEvidence", "missedNeedsAttention", "notification"].includes(entry.kind);
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? value : undefined;
}
