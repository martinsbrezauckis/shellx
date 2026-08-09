import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceUiControlControllerBindingFixture,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-connectors-owned-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-connectors-owned-token-0001";
const sessionId = "fixture-ui-connectors-owned-session-0001";
const instanceId = "fixture-ui-connectors-owned-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureId = "ui:connectors-owned-renderer-fixture";
const productionNames = [
  "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-1\"]",
  "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-12\"]",
  "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-17\"]",
  "src/components/settings/ConnectorsTab.tsx:[data-debug-id=\"surface-components-settings-connectorstab-18\"]",
  "src/components/settings/ConnectorsTab.tsx:role=button;name=\"Delete\"",
].sort();
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
      && assignment.fixtureId === fixtureId
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `owned Connectors assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 4);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 4);

  const blocked = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.fixtureId === "ui:connectors-excluded-provider-vault-session-or-operator-state"
  ));
  assert.deepEqual(blocked, [], "production Connectors controls must not retain stale BUILDING assignments");
  const production = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-connectors-production-lifecycle-installed"
    && assignment.fixtureId.startsWith("ui:connectors-production-owned-")
  ));
  assert.deepEqual(
    production.map((assignment) => inventoryById.get(assignment.surfaceId)?.name).sort(),
    productionNames,
  );
  assert(production.every((assignment) => (
    !assignment.expectedEffect.startsWith("BUILDING:")
    && assignment.cleanupId === "ui:delete-owned-connectors-reset-isolated-vault-restore-settings-and-teardown-profile"
  )));

  const connectorsSource = readFileSync(join(root, "src/components/settings/ConnectorsTab.tsx"), "utf8");
  const settingsSource = readFileSync(join(root, "src/components/Settings.tsx"), "utf8");
  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert(connectorsSource.includes('debugFixtureActive ? DEBUG_OWNED_CONNECTORS : connectors'));
  assert(connectorsSource.includes('debugFixtureActive ? DEBUG_OWNED_SESSIONS : sessions'));
  assert(connectorsSource.includes('data-connectors-debug-fixture={debugFixtureActive ? "owned-safe" : undefined}'));
  assert(connectorsSource.includes('disabled={busy || !desktopConnectorsAvailable || debugFixtureActive}'));
  assert(connectorsSource.includes('disabled={testing || fixtureLocked}'));
  assert(connectorsSource.includes('disabled={fixtureLocked}'));
  assert(settingsSource.includes("<ConnectorsTab debugFixture={connectorsDebugFixture} />"));
  assert(appSource.includes('p.debugConnectorsFixture === "owned-safe"'));
  assert(appSource.includes('p.debugConnectorsFixture === "clear"'));
  assert.equal(
    UI_CONTROL_INSTALLED_CONTROLLER_FILES.filter((path) => path === "scripts/release-drivers/ui-control-connectors-owned.ts").length,
    1,
    "the generic Connectors controller must be registered exactly once",
  );

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

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
    controllerFiles: string[];
  };
  assert(manifest.supportedFixtures.includes(fixtureId));
  assert(manifest.supportedCleanups.includes("ui:clear-connectors-owned-fixture-and-close-settings"));
  assert(manifest.supportedOracles.includes("ui:value-state-transition"));
  assert(manifest.supportedOracles.includes("ui:choice-state-transition"));
  assert(manifest.supportedOracles.includes("ui:activation:owned-connector-edit-opened"));
  assert.deepEqual(manifest.controllerFiles, [...UI_CONTROL_INSTALLED_CONTROLLER_FILES]);

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceUiControlControllerBindingFixture(),
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
        port: Number(new URL(candidateBase).port),
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
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 4);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    settingsOpen: boolean;
    connectorsFixtureActive: boolean;
    connectorDraftOpen: boolean;
    connectorSecretValue: string;
    connectorFixedTabId: string;
    connectorSimConnectorId: string;
    connectorEditingId: string;
    connectorUnsafeMutationCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.connectorsFixtureActive, false);
  assert.equal(audit.connectorDraftOpen, false);
  assert.equal(audit.connectorSecretValue, "");
  assert.equal(audit.connectorFixedTabId, "");
  assert.equal(audit.connectorSimConnectorId, "");
  assert.equal(audit.connectorEditingId, "");
  assert.equal(audit.connectorUnsafeMutationCount, 0);
  assert(audit.clickedSelectors.includes("[data-connector-id='release-owned-connector-telegram'] .connection-row-meta > button:nth-of-type(2)"));
  assert(!audit.clickedSelectors.some((selector) => (
    selector.includes("connectorstab-1")
    || selector.includes("connectorstab-12")
    || selector.includes("connectorstab-17")
    || selector.includes("connectorstab-18")
    || selector.includes("settings-pill-danger")
  )), "owned Connectors lifecycle must not invoke Refresh, Save, Simulate, Test, or Delete");

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "owned Connectors evidence output must remain create-only");
  console.log("Owned Connectors native WebDriver lifecycle passed: 4 inert controls and 5 isolated production controls");
} finally {
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
      throw new Error(`owned Connectors fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("owned Connectors fixture did not publish its ports");
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
