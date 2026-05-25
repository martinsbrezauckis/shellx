import assert from "node:assert/strict";
import {
  buildStatusLabel,
  isBuildTerminalStatus,
  isBuildVisible,
  parseBuildCommand,
  type BuildRunState,
} from "../src/lib/build-run";

assert.equal(parseBuildCommand("/build ship the feature"), "ship the feature");
assert.equal(parseBuildCommand("  /build   add receipts"), "add receipts");
assert.equal(parseBuildCommand("/build"), "");
assert.equal(parseBuildCommand("/goal add receipts"), null);

assert.equal(buildStatusLabel("awaitingApproval"), "Awaiting approval");
assert.equal(buildStatusLabel("active"), "Active");
assert.equal(buildStatusLabel(undefined), "Inactive");

assert.equal(isBuildTerminalStatus("complete"), true);
assert.equal(isBuildTerminalStatus("halted"), true);
assert.equal(isBuildTerminalStatus("active"), false);

const state = {
  status: "active",
} as BuildRunState;
assert.equal(isBuildVisible(state), true);
assert.equal(isBuildVisible({ ...state, status: "complete" }), false);
assert.equal(isBuildVisible(null), false);

console.log("test-build-run: ok");
