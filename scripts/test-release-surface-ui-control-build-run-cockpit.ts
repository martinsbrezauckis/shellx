import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  exerciseBuildRunCockpitControl,
  supportsBuildRunCockpitControl,
} from "./release-drivers/ui-control-build-run-cockpit";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-build-run-cockpit-"));
const profileRoot = join(temp, `shellx-final-build-run-cockpit-${"b".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-build-run-cockpit-token-0001";
const sessionId = "fixture-build-run-cockpit-session-0001";
const instanceId = "fixture-build-run-cockpit-instance-0001";
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
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;
  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  assert.equal(request.assignments.length, 8);
  assert(request.assignments.every(supportsBuildRunCockpitControl));
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseBuildRunCockpitControl(
      { base: candidateBase, token },
      input,
      request,
      assignment,
    ));
  }
  assert(outcomes.every((outcome) => (
    outcome.present === "pass" && outcome.invoke === "pass"
    && outcome.effect === "pass" && outcome.cleanup === "pass" && !outcome.error
  )), JSON.stringify(outcomes, null, 2));
  assert(outcomes.some((outcome) => /no build action, project, provider, file, or clipboard path was invoked/i.test(outcome.observedEffect)));
  assert.equal(outcomes.filter((outcome) => /fixed JSONL provider receipt/.test(outcome.observedEffect)).length, 2);

  const audit = await getJson<{
    rightTab?: unknown;
    buildRunCockpitFixtureActive?: unknown;
    buildRunCockpitShowAllReceipts?: unknown;
    buildRunState?: unknown;
    buildRunReceipts?: unknown[];
    buildRunProviderAction?: unknown;
    clickedSelectors?: string[];
  }>(`${candidateBase}/audit`, token);
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.buildRunCockpitFixtureActive, false);
  assert.equal(audit.buildRunCockpitShowAllReceipts, false);
  assert.equal(audit.buildRunState, null);
  assert.deepEqual(audit.buildRunReceipts, []);
  assert.equal(audit.buildRunProviderAction, null);
  const clickedSelectors = audit.clickedSelectors ?? [];
  for (const fragment of [
    "Approve the Build Mode scratchboard",
    "Reject this Build Mode plan",
    "Pause Build Mode auto-continuation",
    "Resume Build Mode auto-continuation",
    "Recheck blocker evidence",
    "Create a local shellX git checkpoint",
    "Stop Build Mode manually",
  ]) {
    assert.equal(clickedSelectors.filter((selector) => selector.includes(fragment)).length, 1, `${fragment} must receive one exact native click`);
  }
  assert.equal(clickedSelectors.filter((selector) => (
    selector.includes("Show every receipt in this Build Mode run")
      && selector.includes("Show latest receipts only")
  )).length, 2, "receipt disclosure must receive one expansion click and one cleanup-collapse click");

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as {
    assignments: Array<{ surfaceId: string; driverId: string; cleanupId: string }>;
  };
  const buildAssignments = plan.assignments.filter((assignment) => assignment.surfaceId.includes("@src/components/BuildRunCockpit.tsx#"));
  assert.equal(buildAssignments.length, 8);
  assert.equal(buildAssignments.filter((assignment) => assignment.driverId.endsWith("-backlog-installed")).length, 0);
  assert(buildAssignments.every((assignment) => assignment.cleanupId !== "ui:not-invoked"));
  console.log("Release surface Build Run Cockpit lifecycle tests passed (8 exact controls; 7 real isolated Build/Git/provider actions; 0 BUILDING blockers)");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
): ReleaseSurfaceDriverRequest {
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
  const assignments = plan.assignments
    .filter((assignment) => (
      assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed"
    ))
    .map((assignment) => ({ assignment, surface: requiredSurface(surfaceById, assignment.surfaceId) }))
    .filter(({ surface }) => surface.source === "src/components/BuildRunCockpit.tsx")
    .map(({ assignment, surface }) => ({
      surface,
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
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
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1_024 },
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
      throw new Error(`Build Run Cockpit fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Build Run Cockpit fixture did not publish its ports");
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
