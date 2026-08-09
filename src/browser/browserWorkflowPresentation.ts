import type { BrowserBookmarkAgentWorkflow } from "./types";

export function browserWorkflowBadgeLabel(workflow: BrowserBookmarkAgentWorkflow): string {
  const rawState = [
    workflow.lastImprovementRating,
    workflow.driftStatus,
    workflow.lastReplayStatus,
    workflow.health,
  ].find((value): value is string => typeof value === "string" && value.length <= 32);
  const state = rawState?.replaceAll("-", " ") ?? null;
  const score = typeof workflow.lastImprovementScore === "number" && Number.isFinite(workflow.lastImprovementScore)
    ? Math.max(-100, Math.min(100, Math.round(workflow.lastImprovementScore)))
    : null;
  if (state && score !== null) return `${state} ${score > 0 ? "+" : ""}${score}`;
  if (state) return state;
  const steps = typeof workflow.steps === "number" && workflow.steps > 0 ? workflow.steps : 0;
  return steps > 0 ? `${steps} step workflow` : "Workflow";
}

export function browserWorkflowNeedsRefresh(workflow: BrowserBookmarkAgentWorkflow): boolean {
  return Boolean(workflow.refreshReason || workflow.refreshCandidateRecipePath);
}
