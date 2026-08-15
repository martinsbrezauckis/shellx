import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import {
  TASK_MANAGER_CONTROL_CLEANUP,
  TASK_MANAGER_CONTROL_DRIVER_ID,
  TASK_MANAGER_CONTROL_FIXTURE,
  TASK_MANAGER_CONTROL_ORACLES,
  TASK_MANAGER_CONTROL_SURFACE_NAMES,
} from "./release-drivers/ui-task-manager-installed-assignments";
import {
  TASK_ENTRY_CLEANUP,
  TASK_ENTRY_CONTROL_DRIVER_ID,
  TASK_ENTRY_CONTROL_ORACLE,
  TASK_ENTRY_CONTROL_SURFACE_IDS,
  TASK_ENTRY_DEBUG_DRIVER_ID,
  TASK_ENTRY_DEBUG_ORACLE,
  TASK_ENTRY_DEBUG_SURFACE_IDS,
  TASK_ENTRY_FIXTURE,
} from "./release-drivers/ui-task-entry-installed-assignments";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-task-manager-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const taskEntryControlRequestPath = join(temp, "task-entry-control-request.json");
const taskEntryControlReportPath = join(temp, "task-entry-control-report.json");
const taskEntryDebugRequestPath = join(temp, "task-entry-debug-request.json");
const taskEntryDebugReportPath = join(temp, "task-entry-debug-report.json");
const token = "fixture-ui-control-task-manager-token-0001";
const sessionId = "fixture-ui-control-task-manager-session-0001";
const instanceId = "fixture-ui-control-task-manager-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
let fixture: ChildProcess | null = null;

const stopFixture = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
};
const onTerminationSignal = (): never => {
  stopFixture();
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === TASK_MANAGER_CONTROL_DRIVER_ID)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Task Manager assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, TASK_MANAGER_CONTROL_SURFACE_NAMES.size);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.name)).size, TASK_MANAGER_CONTROL_SURFACE_NAMES.size);
  assert(assignments.every((assignment) => TASK_MANAGER_CONTROL_SURFACE_NAMES.has(assignment.surface.name)));
  assert(assignments.every((assignment) => assignment.fixtureId === TASK_MANAGER_CONTROL_FIXTURE));
  assert(assignments.every((assignment) => assignment.cleanupId === TASK_MANAGER_CONTROL_CLEANUP));
  assert(assignments.every((assignment) => TASK_MANAGER_CONTROL_ORACLES.includes(
    assignment.oracleId as typeof TASK_MANAGER_CONTROL_ORACLES[number],
  )));

  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-task-manager-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: TASK_MANAGER_CONTROL_DRIVER_ID,
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/ui-control-task-manager-installed.ts",
      [
        "scripts/lib/release-surface-installed-input-client.ts",
        "scripts/lib/release-surface-bounded-observation.ts",
        "scripts/lib/release-surface-macos-native-input.ts",
        "scripts/release-drivers/ui-task-manager-installed-assignments.ts",
        "scripts/release-drivers/ui-control-task-manager.ts",
      ],
    ),
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
      base: `http://127.0.0.1:${ports.webdriverPort}`,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments,
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const entrypoint = resolve(root, "scripts/release-drivers/ui-control-task-manager-installed.ts");
  const described = spawnSync(process.execPath, ["--import", "tsx", entrypoint, "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, TASK_MANAGER_CONTROL_DRIVER_ID);
  assert.deepEqual(manifest.supportedFixtures, [TASK_MANAGER_CONTROL_FIXTURE]);
  assert.deepEqual(manifest.supportedCleanups, [TASK_MANAGER_CONTROL_CLEANUP]);
  assert.deepEqual(manifest.supportedOracles, [...TASK_MANAGER_CONTROL_ORACLES]);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", entrypoint, "--request", requestPath, "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, [run.error?.message, run.stderr, run.stdout, reportText].filter(Boolean).join("\n"));
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, report), []);
  assert.equal(report.outcomes.length, TASK_MANAGER_CONTROL_SURFACE_NAMES.size);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
  )), JSON.stringify(report.outcomes, null, 2));

  const taskEntryLanes = [
    {
      driverId: TASK_ENTRY_CONTROL_DRIVER_ID,
      driverKind: "ui-control" as const,
      entrypoint: "scripts/release-drivers/ui-control-task-entry-installed.ts",
      oracleId: TASK_ENTRY_CONTROL_ORACLE,
      surfaceIds: TASK_ENTRY_CONTROL_SURFACE_IDS,
      requestPath: taskEntryControlRequestPath,
      reportPath: taskEntryControlReportPath,
    },
    {
      driverId: TASK_ENTRY_DEBUG_DRIVER_ID,
      driverKind: "ui-debug-surface" as const,
      entrypoint: "scripts/release-drivers/ui-debug-task-entry-installed.ts",
      oracleId: TASK_ENTRY_DEBUG_ORACLE,
      surfaceIds: TASK_ENTRY_DEBUG_SURFACE_IDS,
      requestPath: taskEntryDebugRequestPath,
      reportPath: taskEntryDebugReportPath,
    },
  ];
  for (const lane of taskEntryLanes) {
    const laneAssignments = plan.assignments
      .filter((assignment) => assignment.driverId === lane.driverId)
      .map((assignment) => {
        const surface = inventoryById.get(assignment.surfaceId);
        assert(surface, `Task entry assignment ${assignment.surfaceId} must exist in the exact inventory`);
        return { surface, fixtureId: assignment.fixtureId, expectedEffect: assignment.expectedEffect, oracleId: assignment.oracleId, cleanupId: assignment.cleanupId };
      });
    assert.equal(laneAssignments.length, lane.surfaceIds.size);
    assert(laneAssignments.every((assignment) => lane.surfaceIds.has(assignment.surface.id)));
    assert(laneAssignments.every((assignment) => assignment.fixtureId === TASK_ENTRY_FIXTURE));
    assert(laneAssignments.every((assignment) => assignment.cleanupId === TASK_ENTRY_CLEANUP));
    assert(laneAssignments.every((assignment) => assignment.oracleId === lane.oracleId));
    const entryRequest: ReleaseSurfaceDriverRequest = {
      ...request,
      driverId: lane.driverId,
      driverKind: lane.driverKind,
      controller: releaseSurfaceControllerBindingFixture(lane.entrypoint, [
        "scripts/lib/release-surface-installed-input-client.ts",
        "scripts/lib/release-surface-bounded-observation.ts",
        "scripts/lib/release-surface-macos-native-input.ts",
        "scripts/release-drivers/ui-task-entry-installed-assignments.ts",
        "scripts/release-drivers/ui-task-entry-installed.ts",
      ]),
      assignments: laneAssignments,
    };
    writeFileSync(lane.requestPath, `${JSON.stringify(entryRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const laneEntrypoint = resolve(root, lane.entrypoint);
    const laneDescribe = spawnSync(process.execPath, ["--import", "tsx", laneEntrypoint, "--describe"], { cwd: root, encoding: "utf8" });
    assert.equal(laneDescribe.status, 0, laneDescribe.stderr || laneDescribe.stdout);
    const laneManifest = JSON.parse(laneDescribe.stdout) as { id: string; supportedFixtures: string[]; supportedCleanups: string[]; supportedOracles: string[] };
    assert.equal(laneManifest.id, lane.driverId);
    assert.deepEqual(laneManifest.supportedFixtures, [TASK_ENTRY_FIXTURE]);
    assert.deepEqual(laneManifest.supportedCleanups, [TASK_ENTRY_CLEANUP]);
    assert.deepEqual(laneManifest.supportedOracles, [lane.oracleId]);
    const laneRun = spawnSync(process.execPath, [
      "--import", "tsx", laneEntrypoint, "--request", lane.requestPath, "--out", lane.reportPath,
    ], { cwd: root, encoding: "utf8", timeout: 120_000 });
    const laneReportText = existsSync(lane.reportPath) ? readFileSync(lane.reportPath, "utf8") : "";
    assert.equal(laneRun.status, 0, [laneRun.error?.message, laneRun.stderr, laneRun.stdout, laneReportText].filter(Boolean).join("\n"));
    const laneReport = JSON.parse(laneReportText) as ReleaseSurfaceDriverReport;
    assert.deepEqual(validateReleaseSurfaceDriverReport(entryRequest, laneReport), []);
    assert.equal(laneReport.outcomes.length, lane.surfaceIds.size);
    assert(laneReport.outcomes.every((outcome) => (
      outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass"
    )), JSON.stringify(laneReport.outcomes, null, 2));
  }

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    managerOpen: boolean;
    vaultOpen: boolean;
    clickedSelectors: string[];
    keyChords: string[][];
  };
  assert.equal(audit.managerOpen, false, "cleanup must close Task Manager");
  assert.equal(audit.vaultOpen, false, "cleanup must close Vault");
  assert.deepEqual(audit.keyChords, [
    ["\uE008", "\uE004"],
    ["\uE004"],
    ["\uE004"],
    ["\uE008", "\uE004"],
    ["\uE00C"],
  ], "native lifecycle must prove reverse/forward Tab containment and Escape restoration");
  for (const selector of [
    "[data-debug-id='task-manager-action-duplicate']",
    "[data-debug-id='task-manager-action-confirm-delete']",
    "[data-debug-id='task-manager-action-run-now']",
    "[data-debug-id='task-manager-action-save-changes']",
    "[data-debug-id='task-manager-edit-details']",
    "[data-debug-id='task-manager-review-details']",
    "[data-debug-id='task-manager-provider-codex-cli-toggle']",
    "[data-debug-id='task-manager-acknowledge-attention']",
    "[data-debug-id='task-manager-cancel-run-run-fixture-running']",
    "[data-debug-id='task-manager-open-vault']",
    "[data-debug-id='task-manager-backdrop']",
    "[data-debug-id='header-tasks']",
    "[data-debug-id='composer-create-task']",
  ]) {
    assert(audit.clickedSelectors.includes(selector), `native lifecycle must click ${selector}`);
  }

  console.log(`Release surface Task Manager and entry controls passed: ${report.outcomes.length + 5} exact assignments`);
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Task Manager fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Task Manager fixture did not publish its ports");
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
