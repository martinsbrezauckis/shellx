import assert from "node:assert/strict";
import {
  buildStatusLabel,
  buildActionFailureMessage,
  buildApprovalReadinessFromText,
  isBuildTerminalStatus,
  isBuildVisible,
  parseBuildCommand,
  shouldQueuePromptAsBuildOperatorNote,
  type BuildRunState,
} from "../src/lib/build-run";

assert.equal(parseBuildCommand("/build ship the feature"), "ship the feature");
assert.equal(parseBuildCommand("  /build   add receipts"), "add receipts");
assert.equal(parseBuildCommand("/build"), "");
assert.equal(parseBuildCommand("/goal add receipts"), "add receipts");

assert.equal(buildStatusLabel("awaitingApproval"), "Awaiting approval");
assert.equal(buildStatusLabel("active"), "Active");
assert.equal(buildStatusLabel("draft"), "Drafting plan");
assert.equal(buildStatusLabel(undefined), "Inactive");

assert.equal(isBuildTerminalStatus("complete"), true);
assert.equal(isBuildTerminalStatus("halted"), true);
assert.equal(isBuildTerminalStatus("transportFailed"), false);
assert.equal(isBuildTerminalStatus("active"), false);

const state = {
  status: "active",
} as BuildRunState;
assert.equal(isBuildVisible(state), true);
assert.equal(isBuildVisible({ ...state, status: "complete" }), false);
assert.equal(isBuildVisible(null), false);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "active" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "blocked" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "paused" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "transportFailed" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "awaitingApproval" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "draft" }), true);
assert.equal(shouldQueuePromptAsBuildOperatorNote({ ...state, status: "complete" }), false);
assert.equal(shouldQueuePromptAsBuildOperatorNote(null), false);

assert.equal(
  buildActionFailureMessage("pause"),
  "Build action pause is not available for this run. Reconnect or start a fresh /build run.",
);

assert.deepEqual(buildApprovalReadinessFromText(""), {
  ready: false,
  reason: "Waiting for Grok to write the Build Mode scratchboard.",
});
assert.equal(
  buildApprovalReadinessFromText(
    "# Build: test\n\nStatus: DRAFTING\n\n_grok is drafting the build plan..._",
  ).ready,
  false,
);
assert.equal(
  buildApprovalReadinessFromText(`# Build: test

Status: AWAITING_APPROVAL

## Phase 1
Status: PENDING

- [ ] Implement the feature.
- [ ] Run reviewer AI slop wiring audit for fake success, placeholder, and mock gaps.
`).ready,
  true,
);

console.log("test-build-run: ok");
