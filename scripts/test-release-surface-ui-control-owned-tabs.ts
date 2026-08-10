import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-owned-tabs-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const debugRequestPath = join(temp, "debug-request.json");
const debugReportPath = join(temp, "debug-report.json");
const token = "fixture-ui-control-owned-tab-token-0001";
const sessionId = "fixture-ui-control-owned-tab-session-0001";
const instanceId = "fixture-ui-control-owned-tab-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureIds = new Set([
  "ui:browser-owned-tab-create",
  "ui:browser-owned-tab-row",
  "ui:browser-owned-home-navigation",
  "ui:browser-owned-history-navigation",
  "ui:browser-owned-tab-lock",
  "ui:browser-owned-tab-delegation",
]);
const HEADER_BROWSER = "[data-debug-id='header-shellx-browser']";
const NEW_TAB = "[data-debug-id='shellx-browser-new-tab']";
const NEW_DISPOSABLE_TAB = "[data-debug-id='shellx-browser-new-disposable-tab']";
const HOME = "[data-debug-id='shellx-browser-home']";
const BACK = "[data-debug-id='shellx-browser-back']";
const FORWARD = "[data-debug-id='shellx-browser-forward']";
const RELOAD = "[data-debug-id='shellx-browser-reload']";
const LOCK_TAB = "[data-debug-id='shellx-browser-lock-tab']";
const HANDOFF_TAB = "[data-debug-id='shellx-browser-handoff-tab']";
const TAKE_BACK_TAB = "[data-debug-id='shellx-browser-take-back-tab']";
const controllerFiles = [...UI_CONTROL_INSTALLED_CONTROLLER_FILES];
const debugControllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/shellx-browser-test-cleanup.ts",
  "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts",
  "scripts/release-drivers/ui-debug-browser-delegation-installed.ts",
];
let fixture: ChildProcess | null = null;

const terminateOwnedFixture = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
};
const onTerminationSignal = (): never => {
  terminateOwnedFixture();
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
      && fixtureIds.has(assignment.fixtureId)
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `owned Browser tab assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 11, "the owned Browser tab fixture must cover exactly eleven promoted controls");
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 11);
  assert(assignments.every((assignment) => (
    assignment.cleanupId === "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"
  )));
  const debugAssignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-debug-browser-delegation-installed")
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Browser delegation marker ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(debugAssignments.length, 2, "both trusted Browser delegation markers must use the native lifecycle");
  assert(debugAssignments.every((assignment) => (
    assignment.fixtureId === "ui:browser-owned-tab-delegation-marker"
    && assignment.oracleId === "ui:activation:owned-browser-tab-delegation-marker"
    && assignment.cleanupId === "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"
  )));

  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-owned-bookmarks-server-fixture.ts"),
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
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-installed.ts", controllerFiles),
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

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert([...fixtureIds].every((id) => manifest.supportedFixtures.includes(id)));
  assert(manifest.supportedCleanups.includes("ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"));
  for (const id of [
    "ui:activation:owned-browser-tab-state-transition",
    "ui:activation:owned-browser-tab-focus-transition",
    "ui:activation:owned-browser-home-navigation",
    "ui:activation:owned-browser-history-navigation",
    "ui:activation:owned-browser-tab-lock-transition",
    "ui:activation:owned-browser-tab-delegation-transition",
  ]) assert(manifest.supportedOracles.includes(id), `manifest is missing oracle ${id}`);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.schema, "shellx/release-surface-driver-report@7");
  assert.equal(report.outcomes.length, 11);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("Installed input")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const debugRequest: ReleaseSurfaceDriverRequest = {
    ...request,
    driverId: "ui-debug-browser-delegation-installed",
    driverKind: "ui-debug-surface",
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/ui-debug-browser-delegation-installed.ts",
      debugControllerFiles,
    ),
    assignments: debugAssignments,
  };
  writeFileSync(debugRequestPath, `${JSON.stringify(debugRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const debugDescribed = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-debug-browser-delegation-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(debugDescribed.status, 0, debugDescribed.stderr || debugDescribed.stdout);
  const debugManifest = JSON.parse(debugDescribed.stdout) as {
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(debugManifest.invocationTransport, "native-installed-input");
  assert.deepEqual(debugManifest.controllerFiles, debugControllerFiles);
  assert.deepEqual(debugManifest.supportedFixtures, ["ui:browser-owned-tab-delegation-marker"]);
  assert.deepEqual(debugManifest.supportedCleanups, ["ui:delete-owned-browser-tabs-restore-home-active-tab-and-window"]);
  assert.deepEqual(debugManifest.supportedOracles, ["ui:activation:owned-browser-tab-delegation-marker"]);
  const debugRun = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-debug-browser-delegation-installed.ts"),
    "--request", debugRequestPath,
    "--out", debugReportPath,
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.equal(debugRun.status, 0, debugRun.stderr || debugRun.stdout);
  const debugReport = JSON.parse(readFileSync(debugReportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(debugReport.outcomes.length, 2);
  assert(debugReport.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("genuine Browser")
    && outcome.observedEffect.includes("native-input reachable")
  )), JSON.stringify(debugReport.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    tabs: unknown[];
    activeBrowserTabId: string | null;
    browserWindowOpen: boolean;
    currentWindow: string;
    optionsOpen: boolean;
    homeValue: string;
    homeStored: string | null;
    pendingAlert: unknown;
    acceptedAlertCount: number;
    clickedSelectors: string[];
  };
  assert.deepEqual(audit.tabs, []);
  assert.equal(audit.activeBrowserTabId, null);
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.optionsOpen, false);
  assert.equal(audit.homeValue, "https://example.com/");
  assert.equal(audit.homeStored, null);
  assert.equal(audit.pendingAlert, null);
  assert.equal(audit.acceptedAlertCount, 4);
  for (const selector of [HEADER_BROWSER, NEW_TAB, NEW_DISPOSABLE_TAB, HOME, BACK, FORWARD, RELOAD, LOCK_TAB, HANDOFF_TAB, TAKE_BACK_TAB]) {
    assert(audit.clickedSelectors.includes(selector), `fixture did not observe ${selector}`);
  }
  assert(audit.clickedSelectors.some((selector) => selector.startsWith("[data-debug-id='shellx-browser-tab-")));
  assert(audit.clickedSelectors.some((selector) => selector.startsWith("[data-debug-id='shellx-browser-close-tab-")));

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.notEqual(overwrite.status, 0, "owned Browser tab evidence output must remain create-only");

  console.log("Release surface owned Browser tabs passed: 11 controls plus 2 trusted delegation markers");
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
      throw new Error(`owned Browser tab fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("owned Browser tab fixture did not publish its ports");
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
