import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { ReleaseSurfaceTauriInvokeSession } from "./lib/release-surface-tauri-invoke-client";
import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { exerciseTasksPanelLifecycle } from "./release-drivers/ui-control-tasks-panel-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-tasks-panel-lifecycle-"));
const profileRoot = join(temp, `shellx-final-tasks-panel-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-tasks-panel-lifecycle-token-0001";
const sessionId = "fixture-tasks-panel-lifecycle-session-0001";
const instanceId = "fixture-tasks-panel-lifecycle-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const entrypoint = "scripts/release-drivers/ui-control-tasks-panel-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/lib/release-surface-run-profile.ts",
  "scripts/lib/release-surface-tauri-invoke-client.ts",
  "scripts/release-drivers/ui-control-tasks-panel-lifecycle.ts",
];
const exactSelectors = new Set([
  "[data-debug-id=\"surface-components-taskspanel-3\"]",
  "[data-debug-id=\"surface-components-taskspanel-8\"]",
  "[title=\"Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)\"]",
  "[title=\"Resume (SIGCONT on Unix, NtResumeProcess on Windows)\"]",
  ":is([title=\"Kill (SIGTERM then SIGKILL after 3s)\"],[title=\"Kill terminal and remove its task row\"])",
  "[aria-label=\"Clean Host MCP children for this tab\"]",
]);

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

  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, "ui-control-tasks-panel-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:tasks-panel-owned-process-lifecycles"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:kill-owned-processes-and-restore-tasks-view"]);
  assert.equal(manifest.supportedOracles.length, 6);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const relay = new ReleaseSurfaceTauriInvokeSession({ base: candidateBase, token });
  const outcomes = await exerciseTasksPanelLifecycle(
    { base: candidateBase, token },
    installedInput,
    relay,
    request.assignments,
    request,
  );
  assert.equal(outcomes.length, 6);
  assert(outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  )), JSON.stringify(outcomes, null, 2));
  assert(outcomes.find((outcome) => outcome.oracleId.endsWith("paused"))?.observedEffect.includes("running to stopped"));
  assert(outcomes.find((outcome) => outcome.oracleId.endsWith("resumed"))?.observedEffect.includes("stopped to running"));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    rightTab: string;
    activeTab: { tabId?: string };
    tasksManualRefreshSequence: number;
    tasksCleanupMcpArmed: boolean;
    ownedBackgroundTasks: unknown[];
    expandedBackgroundTaskIds: string[];
    releaseTauriInvokeCount: number;
    rightRailTextValues: Record<string, string>;
    clickedSelectors: string[];
  };
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.tasksManualRefreshSequence, 0);
  assert.equal(audit.tasksCleanupMcpArmed, false);
  assert.deepEqual(audit.ownedBackgroundTasks, []);
  assert.deepEqual(audit.expandedBackgroundTaskIds, []);
  assert.equal(audit.releaseTauriInvokeCount, 0);
  assert.equal(audit.rightRailTextValues["[data-debug-id='tasks-filter-input']"], "");
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-taskspanel-3']"));
  assert(audit.clickedSelectors.some((selector) => selector.includes("surface-components-taskspanel-8")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("Pause (SIGSTOP")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("Resume (SIGCONT")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("Kill terminal and remove its task row")));
  assert.equal(
    audit.clickedSelectors.filter((selector) => selector === "[aria-label='Clean Host MCP children for this tab']").length,
    2,
  );

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const excluded = plan.assignments.filter((assignment) => (
    assignment.surfaceId.includes("src/components/TasksPanel.tsx")
    && assignment.driverId.endsWith("-backlog-installed")
  ));
  assert.deepEqual(excluded.map((assignment) => assignment.surfaceId), []);
  assert(excluded.every((assignment) => (
    assignment.expectedEffect.startsWith("BUILDING: ")
    && assignment.cleanupId === "ui:not-invoked"
  )));

  console.log("Release surface TasksPanel lifecycle passed: 6 exact owned-process controls, two-click Host MCP process-tree cleanup, 2 provider actions, 2 owned clipboard controls, and exact fixture cleanup");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-tasks-panel-lifecycle-installed")
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `TasksPanel assignment ${assignment.surfaceId} must exist in the exact inventory`);
      assert(exactSelectors.has(surface.selector ?? ""), `unexpected TasksPanel selector ${surface.selector}`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 6);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 6);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-tasks-panel-lifecycle-installed",
    driverKind: "ui-control",
    platform: fixturePlatform,
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
      installedPayloadPath: fixtureImagePath,
      installedManifestSha256: "e".repeat(64),
      ...(fixturePlatform === "windows-installed" ? {
        windowsNative: {
          schema: "shellx/release-surface-windows-native-binding@1" as const,
          process: {
            pid: 4321,
            startId: "2026-07-28T17:59:00.000Z",
            imagePath: fixtureImagePath,
            imageSha256: "d".repeat(64),
            imageBytes: 1024,
            imageFileId: `abcd1234:0x${"1".repeat(32)}`,
          },
          listener: { address: "127.0.0.1" as const, port: candidatePort, owningPid: 4321 },
        },
      } : {
        posixNative: releaseSurfacePosixNativeBindingFixture({
          processId: 4321,
          port: candidatePort,
          imagePath: fixtureImagePath,
          imageSha256: "d".repeat(64),
        }),
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

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`TasksPanel fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("TasksPanel fixture did not publish its ports");
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
