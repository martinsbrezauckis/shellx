import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-bottom-panel-lifecycle-"));
const profileRoot = join(temp, `shellx-final-bottom-panel-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-bottom-panel-token-0001";
const sessionId = "fixture-bottom-panel-session-0001";
const instanceId = "fixture-bottom-panel-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-bottom-panel-lifecycle-installed";
const entrypoint = "scripts/release-drivers/ui-control-bottom-panel-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-work-preview-start.ts",
  "scripts/release-drivers/ui-control-bottom-panel-lifecycle.ts",
];
const expectedSurfaceIds = [
  "ui-control:src/components/BottomPanel.tsx:[aria-label^=\"Remove \"]@src/components/BottomPanel.tsx#10",
  "ui-control:src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-24\"]@src/components/BottomPanel.tsx#25",
  "ui-control:src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-9\"]@src/components/BottomPanel.tsx#9",
  "ui-control:src/components/BottomPanel.tsx:role=button;name=\"Inspect\"@src/components/BottomPanel.tsx#11",
  "ui-control:src/components/BottomPanel.tsx:role=button;name=\"Summarize\"@src/components/BottomPanel.tsx#12",
  "ui-control:src/components/BottomPanel.tsx:[data-debug-id=\"surface-components-bottompanel-23\"]@src/components/BottomPanel.tsx#24",
  "ui-control:src/components/BottomPanel.tsx:[aria-label=\"Turn voice chat off and cancel active listening\"]@src/components/BottomPanel.tsx#18",
  "ui-control:src/components/MicButton.tsx:[data-release-control=\"composer-mic-button\"]@src/components/MicButton.tsx#1",
].sort();
const expectedRemainingBacklogIds: string[] = [];
const expectedNativePickerIds = [
  "ui-control:src/components/BottomPanel.tsx:[data-debug-id=\"composer-attach\"]@src/components/BottomPanel.tsx#15",
  "ui-control:src/components/BottomPanel.tsx:[data-debug-id=\"composer-folder\"]@src/components/BottomPanel.tsx#22",
].sort();
const backlogBlockerNeedles = new Map<string, string>();

let fixture: ChildProcess | null = null;
const stop = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
};
const onTerminationSignal = (): never => {
  stop();
  rmSync(temp, { recursive: true, force: true });
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

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

  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id?: string;
    invocationTransport?: string;
    supportedFixtures?: string[];
    supportedCleanups?: string[];
    supportedOracles?: string[];
    controllerFiles?: string[];
  };
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.equal(manifest.supportedFixtures?.length, 6);
  assert.equal(manifest.supportedCleanups?.length, 6);
  assert.equal(manifest.supportedOracles?.length, 7);
  assert.deepEqual(manifest.controllerFiles, controllerFiles);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  assert.deepEqual(request.assignments.map((assignment) => assignment.surface.id).sort(), expectedSurfaceIds);
  const report = runDriver(request);
  assert.equal(report.outcomes.length, 8);
  assert(report.outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(report.outcomes, null, 2));

  const audit = await getJson<Record<string, unknown>>(`${candidateBase}/audit`, token);
  assert.deepEqual(audit.sessionTabIds, ["fixture-active-tab-035"]);
  assert.deepEqual(audit.sessionTabSessionIds, [null]);
  assert.deepEqual(audit.bottomPanelAttachmentPaths, []);
  assert.equal(audit.bottomPanelComposerPrompt, "");
  assert.equal(audit.bottomPanelImagePath, null);
  assert.equal(audit.bottomPanelFixtureUserVisible, false);
  assert.equal(audit.previewTarget, null);
  assert.equal(audit.agentPickerFixtureActive, false);
  assert.equal(audit.releaseTestVoiceRecording, false);
  assert.equal(audit.releaseTestVoiceMode, false);
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(existsSync(join(profileRoot, "ui-bottom-panel-lifecycle")), false);

  console.log("Release surface native BottomPanel lifecycle tests passed (8 controls, 2 native-picker promotions, 0 BUILDING blockers, slash highlight executable)");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  stop();
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as {
    digest: string;
    items: ReleaseSurfaceItem[];
  };
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as {
    drivers: Array<{ id: string; platforms: Record<string, string> }>;
    assignments: Array<{
      surfaceId: string;
      driverId: string;
      fixtureId: string;
      expectedEffect: string;
      oracleId: string;
      cleanupId: string;
    }>;
  };
  const driver = plan.drivers.find((item) => item.id === driverId);
  assert.deepEqual(driver?.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === driverId)
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  const remainingAssignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-backlog-installed"
      && expectedRemainingBacklogIds.includes(assignment.surfaceId));
  assert.deepEqual(remainingAssignments.map((assignment) => assignment.surfaceId).sort(), expectedRemainingBacklogIds);
  for (const assignment of remainingAssignments) {
    assert.equal(assignment.fixtureId, "ui:app-bottom-excluded-provider-picker-session-capture-or-prompt-state");
    assert(assignment.expectedEffect.startsWith("BUILDING: "));
    assert(assignment.expectedEffect.includes(backlogBlockerNeedles.get(assignment.surfaceId)!));
    assert.equal(assignment.cleanupId, "ui:not-invoked");
    if (assignment.surfaceId.includes("bottompanel-23")) assert.equal(assignment.oracleId, "ui:boolean-state-transition");
    else assert(assignment.oracleId.endsWith(":building-blocker"));
  }
  const nativePickerAssignments = plan.assignments
    .filter((assignment) => expectedNativePickerIds.includes(assignment.surfaceId));
  assert.deepEqual(nativePickerAssignments.map((assignment) => assignment.surfaceId).sort(), expectedNativePickerIds);
  assert(nativePickerAssignments.every((assignment) => (
    assignment.driverId === "ui-control-native-picker-lifecycle-installed"
    && !assignment.expectedEffect.startsWith("BUILDING: ")
    && assignment.cleanupId.startsWith("native-picker:")
  )));
  const slashHighlight = plan.assignments.find((assignment) => (
    assignment.surfaceId === "ui-debug-surface:surface-components-bottompanel-24@src/components/BottomPanel.tsx#23"
  ));
  assert(slashHighlight, "the slash command highlight marker must exist in the driver plan");
  assert.equal(slashHighlight.driverId, "ui-debug-surface-installed");
  assert.equal(slashHighlight.fixtureId, "ui:owned-slash-command-row-visible");
  assert.equal(slashHighlight.cleanupId, "ui:clear-debug-highlight-and-restore-owned-state");
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(entrypoint, controllerFiles),
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

function runDriver(requestValue: ReleaseSurfaceDriverRequest): ReleaseSurfaceDriverReport {
  const requestPath = join(temp, "bottom-panel-request.json");
  const reportPath = join(temp, "bottom-panel-report.json");
  writeFileSync(requestPath, `${JSON.stringify(requestValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, [run.stderr, run.stdout, reportText].filter(Boolean).join("\n"));
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.deepEqual(report.nativeWebDriver, requestValue.nativeWebDriver);
  assert.deepEqual(report.controller, requestValue.controller);
  return report;
}

function requiredSurface(surfaceById: Map<string, ReleaseSurfaceItem>, id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  assert(surface, `surface inventory is missing ${id}`);
  return surface;
}

async function getJson<T>(url: string, bearer: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (response.status !== 200) throw new Error(`fixture request failed ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`BottomPanel fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("BottomPanel fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(2_000)]);
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
