import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  GOAL_PLAN_REVIEW_CLEANUPS,
  GOAL_PLAN_REVIEW_FIXTURES,
  GOAL_PLAN_REVIEW_ORACLES,
  exerciseGoalPlanReviewControl,
} from "./release-drivers/ui-control-goal-plan-review";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-goal-plan-review-"));
const profileRoot = join(temp, `shellx-final-goal-plan-review-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-goal-plan-review-token-0001";
const sessionId = "fixture-goal-plan-review-session-0001";
const instanceId = "fixture-goal-plan-review-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;

let fixture: ChildProcess | null = null;
try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    controllerFiles?: string[];
    supportedFixtures?: string[];
    supportedCleanups?: string[];
    supportedOracles?: string[];
  };
  assert.deepEqual(manifest.controllerFiles, [
    "scripts/release-drivers/ui-control-installed.ts",
    "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
    ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
  ]);
  assert(GOAL_PLAN_REVIEW_FIXTURES.every((id) => manifest.supportedFixtures?.includes(id)));
  assert(GOAL_PLAN_REVIEW_CLEANUPS.every((id) => manifest.supportedCleanups?.includes(id)));
  assert(GOAL_PLAN_REVIEW_ORACLES.every((id) => manifest.supportedOracles?.includes(id)));
  const modalSource = readFileSync(join(root, "src/components/GoalPlanReviewModal.tsx"), "utf8");
  assert(!modalSource.includes("window.confirm("));
  assert(modalSource.includes("Confirm rejection and clear this Goal plan"));

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseGoalPlanReviewControl({ base: candidateBase, token }, input, request, assignment));
  }
  assert.equal(outcomes.length, 8);
  assert(outcomes.every((outcome) => outcome.present === "pass"));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"));
  assert(outcomes.every((outcome) => outcome.effect === "pass"));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"));
  assert(outcomes.some((outcome) => outcome.observedEffect.includes("correlated fixed JSONL provider receipt")));

  const finalState = await getJson<{
    goalPlanReviewFixture?: string;
  }>(`${candidateBase}/state/ui`, token);
  assert.equal(finalState.goalPlanReviewFixture, "closed");
  const fixtureState = await getJson<{
    goalPlanReviewEditing?: boolean;
    goalPlanReviewComment?: string;
    goalState?: unknown;
    goalPlanRejectArmed?: boolean;
    goalProviderAction?: unknown;
    clickedSelectors?: string[];
  }>(`${candidateBase}/audit`, token);
  assert.equal(fixtureState.goalPlanReviewEditing, false);
  assert.equal(fixtureState.goalPlanReviewComment, "");
  assert.equal(fixtureState.goalState, null, "the inert fixture must not create backing Goal state");
  assert.equal(fixtureState.goalPlanRejectArmed, false);
  assert.equal(fixtureState.goalProviderAction, null);
  assert.equal(fixtureState.clickedSelectors?.filter((selector) => selector === "[data-debug-id='surface-components-goalplanreviewmodal-4']").length, 1);
  assert.equal(fixtureState.clickedSelectors?.filter((selector) => selector === "[data-debug-id='surface-components-goalplanreviewmodal-7']").length, 2);
  assert.equal(fixtureState.clickedSelectors?.filter((selector) => selector === "[data-debug-id='surface-components-goalplanreviewmodal-9']").length, 1);
  console.log("Release surface Goal Plan Review tests passed (5 inert controls, 3 real isolated Goal/provider actions)");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as {
    digest: string;
    items: ReleaseSurfaceItem[];
  };
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as {
    assignments: Array<{
      surfaceId: string;
      driverId: string;
      fixtureId: string;
      expectedEffect: string;
      oracleId: string;
      cleanupId: string;
    }>;
  };
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const fixtureIds = new Set<string>(GOAL_PLAN_REVIEW_FIXTURES);
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-bounded-installed" && fixtureIds.has(assignment.fixtureId))
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  assert.equal(assignments.length, 8);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bounded-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "d".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "e".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "d".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments,
  };
}

function requiredSurface(surfaceById: Map<string, ReleaseSurfaceItem>, id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  assert(surface, `surface inventory is missing ${id}`);
  return surface;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Goal Plan Review fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Goal Plan Review fixture did not publish its ports");
}

async function getJson<T>(url: string, authToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.json() as T;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
