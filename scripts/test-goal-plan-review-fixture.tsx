import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GoalPlanReviewModal } from "../src/components/GoalPlanReviewModal";
import {
  debugGoalPlanReviewFixture,
  normalizeDebugGoalPlanReviewFixtureMode,
} from "../src/lib/debug-goal-plan-review-fixture";

const common = {
  activeTabId: null,
  eventsLen: 0,
  onPreviewFile: () => {},
  onAccepted: () => {},
  onReviewLater: () => {},
};

const review = renderToStaticMarkup(
  <GoalPlanReviewModal {...common} fixture={debugGoalPlanReviewFixture("review")} />,
);
assert(review.includes('role="dialog"'));
assert(review.includes("Verify the inert ShellX goal plan review lifecycle"));
assert(review.includes('data-debug-id="surface-components-goalplanreviewmodal-1"'));
assert(review.includes('data-debug-id="surface-components-goalplanreviewmodal-7"'));
assert(review.includes('data-debug-id="surface-components-goalplanreviewmodal-9"'));
assert.equal((review.match(/ disabled=""/g) ?? []).length, 2, "only Reject and Accept must be disabled in the inert review fixture");

const editing = renderToStaticMarkup(
  <GoalPlanReviewModal {...common} fixture={debugGoalPlanReviewFixture("editing")} />,
);
assert(editing.includes('data-debug-id="surface-components-goalplanreviewmodal-4"'));
assert(editing.includes('data-shellx-release-observe="value"'));
assert(editing.includes("Send feedback"));
assert(editing.includes("Cancel"));
assert.equal((editing.match(/ disabled=""/g) ?? []).length, 3, "Send feedback, Reject, and Accept must be disabled in the inert editing fixture");
assert(!editing.includes("fixture-command"));

assert.equal(normalizeDebugGoalPlanReviewFixtureMode("closed"), "closed");
assert.equal(normalizeDebugGoalPlanReviewFixtureMode("review"), "review");
assert.equal(normalizeDebugGoalPlanReviewFixtureMode("editing"), "editing");
assert.equal(normalizeDebugGoalPlanReviewFixtureMode("approve"), null);

console.log("Goal Plan Review inert renderer fixture tests passed");
