import type {
  TaskDefinitionDetail,
  TaskDefinitionSummary,
  TaskManagerDraft,
  TaskManagerMode,
  TaskSchedule,
} from "./task-manager-contract";

export interface TaskManagerDraftHydrationInput {
  mode: TaskManagerMode;
  initialDraft?: TaskManagerDraft;
  currentDraft: TaskManagerDraft;
  emptyDraft: TaskManagerDraft;
  selectedDefinitionId?: string;
  selectedDefinition?: TaskDefinitionDetail;
}

/**
 * Changes only when an edit has an exact immutable revision to hydrate. A
 * pending `tasks_get` keeps the local summary draft intact instead of treating
 * the absence of detail as a new empty handoff.
 */
export function taskManagerDraftHandoffKey(
  mode: TaskManagerMode,
  initialDraft: TaskManagerDraft | undefined,
  selectedDefinitionId: string | undefined,
  selectedDefinition: TaskDefinitionDetail | undefined,
): string {
  if (initialDraft) return `draft:${initialDraft.originRequestId}:${initialDraft.originRevision}`;
  if (mode !== "edit") return "create";
  if (!selectedDefinition) return `edit:pending:${selectedDefinitionId ?? "none"}`;
  return `edit:${selectedDefinition.id}:${selectedDefinition.revisionId}:${selectedDefinition.revisionHash}`;
}

/** Resolves an incoming Task Manager handoff without blanking a pending row. */
export function taskManagerIncomingDraft(input: TaskManagerDraftHydrationInput): TaskManagerDraft {
  if (input.initialDraft) return input.initialDraft;
  if (input.mode === "edit") {
    if (input.selectedDefinitionId && !input.selectedDefinition) return input.currentDraft;
    if (input.selectedDefinition) return taskManagerDraftFromDetail(input.selectedDefinition);
  }
  return input.emptyDraft;
}

export function taskManagerDraftFromDetail(detail: TaskDefinitionDetail): TaskManagerDraft {
  return {
    originRequestId: `task-definition-${detail.id}`,
    originRevision: numericRevision(detail.revisionId),
    taskId: detail.id,
    revisionId: detail.revisionId,
    revisionHash: detail.revisionHash,
    name: detail.name,
    instruction: detail.instruction,
    successCriteria: detail.successCriteria,
    environmentKey: detail.environmentKey,
    schedule: detail.schedule,
    enabled: detail.enabled,
    candidates: detail.candidates,
    context: detail.draftContext,
  };
}

export function taskManagerDraftFromSummary(
  summary: TaskDefinitionSummary,
  schedule: TaskSchedule,
): TaskManagerDraft {
  return {
    originRequestId: `task-definition-${summary.id}`,
    originRevision: numericRevision(summary.revisionId),
    taskId: summary.id,
    revisionId: summary.revisionId,
    revisionHash: summary.revisionHash,
    name: summary.name,
    instruction: summary.instructionPreview,
    environmentKey: summary.environmentKey,
    schedule,
    enabled: summary.enabled,
    candidates: [],
  };
}

function numericRevision(revisionId: string): number {
  let total = 0;
  for (const character of revisionId) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return total || 1;
}
