import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  debugTaskManagerFixtureData,
  normalizeDebugTaskManagerFixtureMode,
  updateDebugTaskManagerState,
} from "../src/lib/task-manager-debug-fixture";

const full = debugTaskManagerFixtureData("full");
assert.equal(full.loadState, "ready");
assert(full.providerCatalogue && full.providerCatalogue.freshUntilMs > Date.now());
assert.equal(full.selectedDefinition?.runHistory.find((run) => run.id === "run-fixture-running")?.attemptId, "task-attempt:run-fixture-running:1");
const completed = full.selectedDefinition?.runHistory.find((run) => run.id === "run-fixture-completed");
assert.equal(completed?.traceEvidence?.state, "complete");
assert.match(completed?.conversationSessionId ?? "", /^task-run-[a-f0-9]{32}$/);
assert.equal(completed?.resultEvidence?.state, "complete");
assert.equal(JSON.stringify(full).includes("C:\\Users\\"), false);

assert.equal(debugTaskManagerFixtureData("loading").loadState, "loading");
assert.equal(debugTaskManagerFixtureData("empty").definitions.length, 0);
assert.equal(debugTaskManagerFixtureData("error").loadState, "error");
assert.equal(debugTaskManagerFixtureData("providerEmpty").providerCatalogue, undefined);
assert.equal(debugTaskManagerFixtureData("providerGuard").providerCatalogueState.state, "error");
assert.equal(debugTaskManagerFixtureData("vaultUnavailable").vaultGrantState?.state, "unavailable");
assert.equal(debugTaskManagerFixtureData("vaultRequired").vaultGrantOptions?.length, 0);
assert.equal(debugTaskManagerFixtureData("traceIncomplete").selectedDefinition?.runHistory[2]?.traceEvidence?.state, "incomplete");
assert.equal(debugTaskManagerFixtureData("traceNoActivity").selectedDefinition?.runHistory[2]?.traceEvidence?.state, "noProviderActivity");
assert.equal(debugTaskManagerFixtureData("resultIncomplete").selectedDefinition?.runHistory[2]?.resultEvidence?.state, "incomplete");
assert.equal(debugTaskManagerFixtureData("resultNoActivity").selectedDefinition?.runHistory[2]?.resultEvidence?.state, "noBrowserActivity");
assert.equal(normalizeDebugTaskManagerFixtureMode("full"), "full");
assert.equal(normalizeDebugTaskManagerFixtureMode("clear"), "clear");
assert.equal(normalizeDebugTaskManagerFixtureMode("private-path"), null);

const paused = updateDebugTaskManagerState(full, "pause");
assert.equal(paused.selectedDefinition?.state, "paused");
assert.equal(updateDebugTaskManagerState(paused, "resume").selectedDefinition?.state, "recent");
assert.equal(updateDebugTaskManagerState(full, "cancel").selectedDefinition?.runHistory[1]?.state, "outcomeUnknown");
assert.equal(updateDebugTaskManagerState(full, "resolveAttention").selectedDefinition?.attentionItems.length, 0);
assert.equal(updateDebugTaskManagerState(full, "duplicate").selectedDefinition?.id, "task-fixture-copy");
assert.equal(updateDebugTaskManagerState(full, "runNow").selectedDefinition?.runHistory[0]?.id, "run-fixture-manual");
assert.equal(updateDebugTaskManagerState(full, "delete").loadState, "empty");

const app = readFileSync(resolve(import.meta.dirname, "..", "src", "App.tsx"), "utf8");
const debugApi = readFileSync(resolve(import.meta.dirname, "..", "src-tauri", "src", "debug_api.rs"), "utf8");
for (const required of [
  "normalizeDebugTaskManagerFixtureMode",
  "debugTaskManagerFixtureData(taskManagerFixturePatch)",
  "debugTaskManagerFixtureModeRef.current = taskManagerFixturePatch",
  "if (!debugTaskManagerFixtureModeRef.current) setTaskManagerData(data)",
  "updateDebugTaskManagerState(current, action)",
  '"debugTaskManagerFixture"',
  'applyDebugTaskManagerAction("runNow"',
  'applyDebugTaskManagerAction("cancel"',
  'applyDebugTaskManagerAction("resolveAttention"',
]) assert(app.includes(required), `installed Task fixture wiring is missing ${required}`);
for (const required of [
  'rename = "debugTaskManagerFixture"',
  "pub debug_task_manager_fixture: Option<String>",
]) assert(debugApi.includes(required), `Debug API Task fixture relay is missing ${required}`);

console.log("Task Manager debug fixture passed: bounded states, exact run identities, action transitions, and no private paths.");
