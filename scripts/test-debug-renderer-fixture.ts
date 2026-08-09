import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyDebugRendererFixture,
  debugBuildRunCockpitFixture,
  debugBottomPanelTerminalFixture,
  DEBUG_BUILD_RUN_COCKPIT_FIXTURE,
  DEBUG_BOTTOM_PANEL_LIFECYCLE_FIXTURE,
  DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE,
  DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE,
  DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE,
  isOwnedDebugRendererFrame,
} from "../src/lib/debug-renderer-fixture";
import { groupEvents } from "../src/lib/grouping";
import { extractSessionAssetRegistry } from "../src/lib/session-assets";
import { extractSessionAttachments, extractSessionMedia } from "../src/lib/session-media";
import type { RawEventFrame } from "../src/types/acp";
import { BuildRunCockpit } from "../src/components/BuildRunCockpit";
import {
  debugRightRailGitLifecycleFixture,
  DEBUG_RIGHT_RAIL_GIT_LIFECYCLE_FIXTURE,
} from "../src/lib/debug-right-rail-git-fixture";
import {
  applyDebugPermissionDecisionFixtureEvents,
  debugPermissionDecisionFixture,
  DEBUG_PERMISSION_DECISION_FIXTURE,
} from "../src/lib/debug-permission-decision-fixture";

const unrelated: RawEventFrame = {
  t: 1,
  kind: "ui",
  payload: { _meta: { tabId: "fixture-tab" }, text: "Existing user-owned event" },
};
const projected = applyDebugRendererFixture([unrelated], {
  id: DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE,
  attachmentPath: "/tmp/shellx-owned-attachment.txt",
  imagePath: "/tmp/shellx-owned-image.png",
  videoPath: "/tmp/shellx-owned-video.mp4",
}, "fixture-tab", 1_000);

assert.equal(projected.length, 8);
assert.equal(projected.filter(isOwnedDebugRendererFrame).length, 7);
const groups = groupEvents(projected);
assert(groups.some((group) => group.kind === "thought"));
assert(groups.some((group) => group.kind === "permission" && group.pending));
assert(groups.some((group) => (
  group.kind === "tool"
  && group.diffPath === "shellx-final-owned.ts"
  && group.diffNewText === "export const ready = true;\n"
)));
assert.equal(extractSessionAttachments(groups).length, 1);
assert.deepEqual(extractSessionMedia(groups).images.map((item) => item.path), [
  "/tmp/shellx-owned-image.png",
]);
assert.deepEqual(extractSessionMedia(groups).videos.map((item) => item.path), [
  "/tmp/shellx-owned-video.mp4",
]);
assert.equal(extractSessionAssetRegistry(projected, [{
  tabId: "fixture-tab",
  sessionId: "fixture-session",
  title: "Fixture",
}]).images.length, 1);
assert.equal(extractSessionAssetRegistry(projected, [{
  tabId: "fixture-tab",
  sessionId: "fixture-session",
  title: "Fixture",
}]).videos.length, 1);

const projectedExternal = applyDebugRendererFixture([unrelated], {
  id: DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE,
  attachmentPath: "/tmp/shellx-owned-attachment.txt",
  imagePath: "/tmp/shellx-owned-image.png",
  externalLinkUrl: "https://example.invalid/shellx/release-docs",
}, "fixture-tab", 1_500);
assert(projectedExternal.some((frame) => (
  JSON.stringify(frame.payload).includes("[Owned release documentation](https://example.invalid/shellx/release-docs)")
)), "the bounded renderer fixture must project the exact owned HTTP markdown link");

const cleared = applyDebugRendererFixture(projected, "clear", "fixture-tab", 2_000);
assert.deepEqual(cleared, [unrelated], "cleanup must remove only exact tagged fixture frames");
assert.deepEqual(
  applyDebugRendererFixture([unrelated], { id: "unknown" }, "fixture-tab", 3_000),
  [unrelated],
  "unknown fixture commands must be inert",
);

const chatLifecycle = applyDebugRendererFixture([unrelated], {
  id: DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE,
}, "fixture-tab", 4_000);
assert.equal(chatLifecycle.filter(isOwnedDebugRendererFrame).length, 36);
const chatGroups = groupEvents(chatLifecycle);
assert(chatGroups.some((group) => group.kind === "thought"));
assert(chatGroups.some((group) => group.kind === "doom-loop"));
assert(chatGroups.some((group) => group.kind === "host-mcp-unreachable"));
assert.equal(extractSessionAttachments(chatGroups).length, 0);
assert.equal(extractSessionMedia(chatGroups).images.length, 0);
assert.equal(extractSessionMedia(chatGroups).videos.length, 0);
const coexistingChatLifecycle = applyDebugRendererFixture(projected, {
  id: DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE,
}, "fixture-tab", 4_500);
assert.deepEqual(
  applyDebugRendererFixture(coexistingChatLifecycle, {
    id: DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE,
    action: "clear",
  }, "fixture-tab", 5_000),
  projected,
  "ChatOutput cleanup must preserve every unrelated debug-owned renderer frame",
);

const keyboardDiff = applyDebugRendererFixture(projected, {
  id: DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE,
}, "fixture-tab", 5_500);
const keyboardDiffGroup = groupEvents(keyboardDiff).find((group) => (
  group.kind === "tool" && group.diffPath === "release-keyboard-diff.txt"
));
assert(keyboardDiffGroup?.kind === "tool");
assert.equal((keyboardDiffGroup.diffNewText?.match(/^@@/gm) ?? []).length, 3);
assert.deepEqual(
  applyDebugRendererFixture(keyboardDiff, {
    id: DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE,
    action: "clear",
  }, "fixture-tab", 6_000),
  projected,
  "keyboard diff cleanup must remove only its renderer-only ACP frames",
);

assert.deepEqual(debugBottomPanelTerminalFixture({
  id: DEBUG_BOTTOM_PANEL_LIFECYCLE_FIXTURE,
  terminalId: "release-terminal-owned.035",
  label: "owned fixture",
}), [{ terminalId: "release-terminal-owned.035", label: "owned fixture", fixtureOnly: true }]);
assert.deepEqual(debugBottomPanelTerminalFixture("clear"), []);
assert.equal(debugBottomPanelTerminalFixture({ id: "unknown" }), null);
assert.equal(debugBottomPanelTerminalFixture({
  id: DEBUG_BOTTOM_PANEL_LIFECYCLE_FIXTURE,
  terminalId: "not bounded / unsafe",
  label: "owned fixture",
}), null);

const buildCockpit = debugBuildRunCockpitFixture({
  id: DEBUG_BUILD_RUN_COCKPIT_FIXTURE,
}, "fixture-tab", 10_000);
assert(buildCockpit);
assert.equal(buildCockpit.fixtureOnly, true);
assert.equal(buildCockpit.state.tabId, "fixture-tab");
assert.equal(buildCockpit.state.status, "halted");
assert.equal(buildCockpit.state.cwd, "");
assert.equal(buildCockpit.state.scratchboardPath, "");
assert.equal(buildCockpit.receipts.length, 8);
assert.equal(buildCockpit.receipts.at(-1)?.kind, "runHalted");
assert(buildCockpit.receipts.every((receipt) => receipt.data && typeof receipt.data === "object"));
const buildCockpitMarkup = renderToStaticMarkup(createElement(BuildRunCockpit, {
  activeTabId: "fixture-tab",
  state: buildCockpit.state,
  receipts: buildCockpit.receipts,
  scratchboardText: buildCockpit.scratchboardText,
}));
assert.equal((buildCockpitMarkup.match(/class="build-receipt /g) ?? []).length, 6);
assert.match(buildCockpitMarkup, /title="Show every receipt in this Build Mode run"/);
assert.match(buildCockpitMarkup, />All 8<\/button>/);
assert.equal(buildCockpitMarkup.includes(">Approve</button>"), false);
assert.equal(buildCockpitMarkup.includes(">Checkpoint</button>"), false);
assert.equal(buildCockpitMarkup.includes(">Stop</button>"), false);
const appSource = readFileSync("src/App.tsx", "utf8");
const rightRailSource = readFileSync("src/components/RightRail.tsx", "utf8");
const gitPaneSource = readFileSync("src/components/GitPane.tsx", "utf8");
const permissionModalSource = readFileSync("src/components/PermissionModal.tsx", "utf8");
const permissionPillSource = readFileSync("src/components/PermissionPill.tsx", "utf8");
const chatOutputSource = readFileSync("src/components/ChatOutput.tsx", "utf8");
assert(appSource.includes("setDebugBuildRunFixture(debugBuildRunCockpitFixture("));
assert(appSource.includes("debugBuildRunFixture={debugBuildRunFixture}"));
assert(rightRailSource.includes("const renderedBuildState = debugBuildRunFixture?.state ?? buildState"));
assert(rightRailSource.includes("state={renderedBuildState}"));
assert.equal(debugBuildRunCockpitFixture("clear", "fixture-tab"), null);
assert.equal(debugBuildRunCockpitFixture({ id: "unknown" }, "fixture-tab"), null);

assert.equal(
  debugRightRailGitLifecycleFixture({ id: "unknown" }, "fixture-tab"),
  undefined,
  "unrelated renderer fixture commands must not alter the RightRail/Git fixture",
);
const rightRailGitFixture = debugRightRailGitLifecycleFixture({
  id: DEBUG_RIGHT_RAIL_GIT_LIFECYCLE_FIXTURE,
}, "fixture-tab");
assert(rightRailGitFixture);
assert.equal(rightRailGitFixture.fixtureOnly, true);
assert.equal(rightRailGitFixture.gitStatus.tabId, "fixture-tab");
assert.equal(rightRailGitFixture.gitStatus.repoRoot, "release-owned-renderer-fixture");
assert.deepEqual(Object.keys(rightRailGitFixture.gitDiffs).sort(), ["head", "lastCommit", "staged", "working"]);
assert.equal(rightRailGitFixture.modelInstructionCards.cards.length, 0);
assert.equal(rightRailGitFixture.modelInstructionCards.policy.defaultRouteMode, "explicitOnly");
assert.equal(
  debugRightRailGitLifecycleFixture({
    id: DEBUG_RIGHT_RAIL_GIT_LIFECYCLE_FIXTURE,
    action: "clear",
  }, "fixture-tab"),
  null,
  "fixture-specific cleanup must clear only the RightRail/Git fixture",
);
assert(
  gitPaneSource.includes("if (!activeTabId || debugFixture) return;")
    && gitPaneSource.includes("if (!activeTabId || !status?.ok || debugFixture) return;")
    && gitPaneSource.includes("disabled={loading || Boolean(debugFixture)}")
    && gitPaneSource.includes("onMouseUp={debugFixture ? undefined : onMouseUpAutoCopy}"),
  "the owned read fixture must fail closed for Git mutation and selection auto-copy paths",
);

assert.equal(debugPermissionDecisionFixture({ id: "unknown" }), undefined);
const permissionPillFixture = debugPermissionDecisionFixture({
  id: DEBUG_PERMISSION_DECISION_FIXTURE,
  action: "pill-always",
});
assert(permissionPillFixture);
assert.equal(permissionPillFixture.fixtureOnly, true);
assert.equal(permissionPillFixture.surface, "pill");
assert.equal(permissionPillFixture.expectedDecision, "allow_always");
const permissionFrames = applyDebugPermissionDecisionFixtureEvents(
  [unrelated],
  permissionPillFixture,
  "fixture-tab",
  11_000,
);
assert.equal(permissionFrames.length, 2);
assert.equal(permissionFrames[1]?.kind, "permission-request");
assert.equal(
  (permissionFrames[1]?.payload as { reqId?: string }).reqId,
  permissionPillFixture.requestId,
);
assert.deepEqual(
  applyDebugPermissionDecisionFixtureEvents(permissionFrames, null, "fixture-tab", 12_000),
  [unrelated],
  "permission cleanup removes only exact tagged fixture frames",
);
const permissionModalFixture = debugPermissionDecisionFixture({
  id: DEBUG_PERMISSION_DECISION_FIXTURE,
  action: "modal-backdrop-deny",
});
assert(permissionModalFixture);
assert.equal(permissionModalFixture.surface, "modal");
assert.equal(permissionModalFixture.expectedDecision, "deny");
assert.equal(permissionModalFixture.expectedModalSource, "backdrop");
assert.equal(debugPermissionDecisionFixture({
  id: DEBUG_PERMISSION_DECISION_FIXTURE,
  action: "clear",
}), null);
assert(
  permissionModalSource.includes("debugFixture.expectedModalSource !== source")
    && permissionModalSource.includes("debugFixture.expectedDecision !== decision")
    && permissionPillSource.includes("debugFixture.expectedDecision !== decision")
    && permissionPillSource.includes("if (!debugFixture)")
    && chatOutputSource.includes("debugPermissionFixture?.requestId === group.requestId"),
  "permission fixture bypass remains exact-request, exact-action, and debug-only",
);

console.log("Debug renderer fixture tests passed");
