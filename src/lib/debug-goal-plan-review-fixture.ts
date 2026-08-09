import type { GoalPlanReviewFixture } from "../components/GoalPlanReviewModal";

export type DebugGoalPlanReviewFixtureMode = "closed" | "review" | "editing";

const baseFixture: GoalPlanReviewFixture = {
  tabId: "release-surface-goal-plan-review",
  goal: {
    active: true,
    objective: "Verify the inert ShellX goal plan review lifecycle",
    scratchboardPath: "/shellx-release-surface/goal-plan-review/goal.md",
    continuationsTotal: 0,
    startedAtMs: 0,
    pausedByUser: false,
    haltedReason: null,
    awaitingApproval: true,
    planTurnCompleted: true,
    approvalStatus: { ready: true, reason: null },
  },
  planText: [
    "# Verify the inert ShellX goal plan review lifecycle",
    "Status: awaiting_approval",
    "",
    "## Phase 1",
    "Inspect the synthetic renderer-only review surface.",
    "",
    "## Phase 2",
    "Restore the exact closed fixture baseline without invoking a provider.",
  ].join("\n"),
};

const reviewFixture: GoalPlanReviewFixture = Object.freeze({
  ...baseFixture,
  goal: Object.freeze({ ...baseFixture.goal }),
});

const editingFixture: GoalPlanReviewFixture = Object.freeze({
  ...baseFixture,
  goal: Object.freeze({ ...baseFixture.goal }),
  editing: true,
  editComment: "",
});

export function normalizeDebugGoalPlanReviewFixtureMode(
  value: unknown,
): DebugGoalPlanReviewFixtureMode | null {
  return value === "closed" || value === "review" || value === "editing"
    ? value
    : null;
}

export function debugGoalPlanReviewFixture(
  mode: Exclude<DebugGoalPlanReviewFixtureMode, "closed">,
): GoalPlanReviewFixture {
  return mode === "editing" ? editingFixture : reviewFixture;
}
