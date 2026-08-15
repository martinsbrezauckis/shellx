import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceBoundedUiControlControllerBindingFixture,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-remote-cwd-lifecycle-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-remote-cwd-token-0001";
const sessionId = "fixture-ui-remote-cwd-session-0001";
const instanceId = "fixture-ui-remote-cwd-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureId = "ui:remote-cwd-owned-local-tree";
const cleanupId = "ui:close-remote-cwd-picker-delete-owned-tree";
const promotedSurfaceIds = [
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-close"]@src/App.tsx#1',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-input"]@src/App.tsx#2',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-go"]@src/App.tsx#3',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-use"]@src/App.tsx#4',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-up"]@src/App.tsx#5',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#6',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-parent"]@src/App.tsx#7',
  'ui-control:src/App.tsx:[data-debug-id="remote-cwd-folder"]@src/App.tsx#8',
].sort();
const formerlyBlockedSurfaceDrivers = new Map<string, string>([
  ['ui-control:src/App.tsx:[aria-label="Download Grok session artifacts"]@src/App.tsx#9', "ui-control-bounded-installed"],
  ['ui-control:src/components/BottomPanel.tsx:[aria-label="Turn voice chat off and cancel active listening"]@src/components/BottomPanel.tsx#18', "ui-control-bottom-panel-lifecycle-installed"],
]);
const nativePickerSurfaceIds = [
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-attach"]@src/components/BottomPanel.tsx#15',
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-folder"]@src/components/BottomPanel.tsx#22',
].sort();
const tempPrefix = "shellx-release-ui-remote-cwd-";
const tempRootsBefore = ownedTempRoots();
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const promoted = plan.assignments.filter((assignment) => promotedSurfaceIds.includes(assignment.surfaceId));
  assert.deepEqual(promoted.map((assignment) => assignment.surfaceId).sort(), promotedSurfaceIds);
  assert(promoted.every((assignment) => (
    assignment.driverId === "ui-control-bounded-installed"
    && assignment.fixtureId === fixtureId
    && assignment.cleanupId === cleanupId
    && (assignment.oracleId === "ui:activation:remote-cwd-path-transition"
      || assignment.oracleId === "ui:value-state-transition")
    && !assignment.expectedEffect.startsWith("BUILDING:")
  )));

  const formerlyBlocked = plan.assignments.filter((assignment) => formerlyBlockedSurfaceDrivers.has(assignment.surfaceId));
  assert.deepEqual(formerlyBlocked.map((assignment) => assignment.surfaceId).sort(), [...formerlyBlockedSurfaceDrivers.keys()].sort());
  for (const assignment of formerlyBlocked) {
    assert.equal(assignment.driverId, formerlyBlockedSurfaceDrivers.get(assignment.surfaceId));
    assert(!assignment.expectedEffect.startsWith("BUILDING: "));
    assert.notEqual(assignment.cleanupId, "ui:not-invoked");
  }
  const nativePickerAssignments = plan.assignments.filter((assignment) => nativePickerSurfaceIds.includes(assignment.surfaceId));
  assert.deepEqual(nativePickerAssignments.map((assignment) => assignment.surfaceId).sort(), nativePickerSurfaceIds);
  assert(nativePickerAssignments.every((assignment) => (
    assignment.driverId === "ui-control-native-picker-lifecycle-installed"
    && !assignment.expectedEffect.startsWith("BUILDING: ")
    && assignment.cleanupId.startsWith("native-picker:")
  )));
  const slashHighlight = plan.assignments.find((assignment) => (
    assignment.surfaceId === "ui-debug-surface:surface-components-bottompanel-24@src/components/BottomPanel.tsx#23"
  ));
  assert.equal(slashHighlight?.driverId, "ui-debug-surface-installed");
  assert.equal(slashHighlight?.fixtureId, "ui:owned-slash-command-row-visible");

  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  const driverSource = readFileSync(join(root, "scripts/release-drivers/ui-control-remote-cwd-lifecycle.ts"), "utf8");
  assert(appSource.includes("picker.isolated === true"));
  assert(appSource.includes('data-shellx-release-observe="value"'));
  assert(appSource.includes('data-shellx-release-observe="disabled"'));
  assert(driverSource.includes("mkdtempSync"));
  assert(driverSource.includes('isolated: action !== "use"'));
  assert(driverSource.includes("waitForReleaseSurfaceInstalledInputElementAbsent"));
  assert(driverSource.includes('remote-cwd-use\"]@'), "the persist-to-tab Use control must stay bound to the exact owned active-tab cohort");

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
  const baseline = await getAudit(candidateBase);

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
    controllerFiles: string[];
  };
  assert(manifest.supportedFixtures.includes(fixtureId));
  assert(manifest.supportedCleanups.includes(cleanupId));
  assert(manifest.supportedOracles.includes("ui:activation:remote-cwd-path-transition"));
  assert.equal(manifest.controllerFiles.filter((path) => path === "scripts/release-drivers/ui-control-remote-cwd-lifecycle.ts").length, 1);

  const assignments = promoted.map((assignment) => ({
    surface: surfaceById.get(assignment.surfaceId)!,
    fixtureId: assignment.fixtureId,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    cleanupId: assignment.cleanupId,
  }));
  assert(assignments.every((assignment) => assignment.surface));
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bounded-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceBoundedUiControlControllerBindingFixture(),
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
        port: ports.candidatePort,
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
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, run.stderr || run.stdout || reportText);
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, promotedSurfaceIds.length);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.toLowerCase().includes("native webdriver")
  )), JSON.stringify(report.outcomes, null, 2));

  const audit = await getAudit(candidateBase);
  assert.deepEqual(audit.activeTab, baseline.activeTab, "the isolated picker must not alter the active tab");
  assert.deepEqual(audit.sessionTabIds, baseline.sessionTabIds, "the isolated picker must not create or close tabs");
  assert.equal(audit.remoteCwdOpen, false);
  assert.equal(audit.remoteCwdPath, "");
  assert.equal(audit.remoteCwdDraft, "");
  assert.equal(audit.remoteCwdUnsafeUseCount, 0);
  assert.equal(audit.remoteCwdIsolatedLaunchCount, promotedSurfaceIds.length - 1);
  assert.equal(audit.remoteCwdOwnedUseLaunchCount, 1);
  assert.deepEqual(audit.clickedSelectors, [
    "[data-debug-id='remote-cwd-close']",
    "[data-debug-id='remote-cwd-folder']",
    "[data-debug-id='remote-cwd-go']",
    "[data-debug-id='remote-cwd-parent']",
    "[data-debug-id='remote-cwd-parent']",
    "[data-debug-id='remote-cwd-up']",
    "[data-debug-id='remote-cwd-use']",
  ]);
  assert.deepEqual(ownedTempRoots(), tempRootsBefore, "every owned Remote Folder tree must be deleted");
  assert.equal(readFileSync(tokenPath, "utf8"), token, "the synthetic credential must remain unchanged");
  assert(!reportText.includes(token), "the synthetic credential must not enter release evidence");

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "Remote Folder lifecycle evidence output must remain create-only");
  console.log("Remote Folder native lifecycle passed: 8 promoted controls, 2 native-picker promotions, 0 exact BUILDING blockers");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function ownedTempRoots(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(tempPrefix)).sort();
}

async function getAudit(base: string): Promise<{
  activeTab: Record<string, unknown>;
  sessionTabIds: string[];
  remoteCwdOpen: boolean;
  remoteCwdPath: string;
  remoteCwdDraft: string;
    remoteCwdUnsafeUseCount: number;
    remoteCwdIsolatedLaunchCount: number;
    remoteCwdOwnedUseLaunchCount: number;
  clickedSelectors: string[];
}> {
  const response = await fetch(`${base}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return await response.json() as Awaited<ReturnType<typeof getAudit>>;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Remote Folder fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Remote Folder fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
