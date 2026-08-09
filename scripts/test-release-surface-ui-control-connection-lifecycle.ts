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
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-connection-lifecycle-"));
const profileRoot = join(temp, `shellx-final-connection-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-connection-token-0001";
const sessionId = "fixture-connection-session-0001";
const instanceId = "fixture-connection-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-connection-lifecycle-installed";
const entrypoint = "scripts/release-drivers/ui-control-connection-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-connection-lifecycle.ts",
];
const expectedSurfaceIds = [
  "ui-control:src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-agent-cli-setup-open\"]@src/components/ConnectionEditor.tsx#13",
  "ui-control:src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-12\"]@src/components/ConnectionEditor.tsx#12",
  "ui-control:src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-14\"]@src/components/ConnectionEditor.tsx#14",
  "ui-control:src/components/ConnectionEditor.tsx:[data-debug-id=\"surface-components-connectioneditor-16\"]@src/components/ConnectionEditor.tsx#16",
  "ui-control:src/components/ConnectionPicker.tsx:[aria-label=\"Confirm delete connection\"]@src/components/ConnectionPicker.tsx#3",
  "ui-control:src/components/ConnectionPicker.tsx:[aria-label^=\"Delete \"]@src/components/ConnectionPicker.tsx#8",
  "ui-control:src/components/ConnectionPicker.tsx:role=button;name=\"Cancel\"@src/components/ConnectionPicker.tsx#2",
  "ui-control:src/components/ConnectionPicker.tsx:role=button;name=\"Edit\"@src/components/ConnectionPicker.tsx#7",
  "ui-control:src/components/ConnectionPicker.tsx:[title^=\"Use \"]@src/components/ConnectionPicker.tsx#4",
  "ui-control:src/components/ConnectionPicker.tsx:role=button;name=\"Test\"@src/components/ConnectionPicker.tsx#6",
  "ui-control:src/components/settings/ConnectionsTab.tsx:[aria-label=\"Cancel delete connection\"]@src/components/settings/ConnectionsTab.tsx#3",
  "ui-control:src/components/settings/ConnectionsTab.tsx:[aria-label=\"Confirm delete saved connection\"]@src/components/settings/ConnectionsTab.tsx#4",
  "ui-control:src/components/settings/ConnectionsTab.tsx:[data-debug-id=\"surface-components-settings-connectionstab-2\"]@src/components/settings/ConnectionsTab.tsx#2",
  "ui-control:src/components/settings/ConnectionsTab.tsx:[title=\"Delete this connection preset\"]@src/components/settings/ConnectionsTab.tsx#6",
  "ui-control:src/components/settings/ConnectionsTab.tsx:[title=\"Edit this connection\"]@src/components/settings/ConnectionsTab.tsx#5",
].sort();
const expectedRemainingBacklogIds: string[] = [];

let fixture: ChildProcess | null = null;
const stop = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
};

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
  const manifest = JSON.parse(described.stdout) as Record<string, unknown>;
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:owned-connection-record-picker", "ui:owned-connection-record-edit", "ui:owned-connection-record-settings", "ui:owned-connection-record-local-probe"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:close-connection-ui-delete-owned-record-restore-directory"]);
  assert.deepEqual(manifest.supportedOracles, [
    "ui:activation:owned-connection-editor-opened",
    "ui:activation:owned-connection-record-saved",
    "ui:activation:owned-connection-delete-confirmation-opened",
    "ui:activation:owned-connection-delete-cancelled",
    "ui:activation:owned-connection-record-deleted",
    "ui:activation:owned-connection-directory-refreshed",
    "ui:activation:owned-connection-provider-scan-completed",
    "ui:activation:owned-connection-test-completed",
    "ui:activation:owned-connection-selected",
    "ui:activation:owned-connection-agent-setup-opened",
  ]);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  assert.deepEqual(request.assignments.map((assignment) => assignment.surface.id).sort(), expectedSurfaceIds);
  const report = runDriver(request);
  assert.equal(report.outcomes.length, 15);
  assert(report.outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(report.outcomes, null, 2));

  const audit = await getJson<Record<string, unknown>>(`${candidateBase}/audit`, token);
  assert.deepEqual(audit.connectionPresets, []);
  assert.equal(audit.connectionEditorOpen, false);
  assert.equal(audit.connectionEditorOwnedId, null);
  assert.equal(audit.connectionEditorProviderScan, null);
  assert.deepEqual(audit.connectionTestResults, {});
  assert.equal(audit.composerPicker, null);
  assert.equal(audit.pendingAlertText, null);
  assert.equal(audit.pendingConnectionDeleteId, null);
  assert.equal(audit.pendingSettingsConnectionDeleteId, null);
  assert.deepEqual(audit.settingsConnectionRows, []);
  assert.equal(audit.settingsConnectionsRefreshCount, 1);

  console.log("Release surface native connection lifecycle tests passed (15 controls, 0 explicit BUILDING controls)");
} finally {
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
    assignments: Array<{ surfaceId: string; driverId: string; fixtureId: string; expectedEffect: string; oracleId: string; cleanupId: string }>;
  };
  const driver = plan.drivers.find((item) => item.id === driverId);
  assert.deepEqual(driver?.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId).map((assignment) => ({
    surface: requiredSurface(surfaceById, assignment.surfaceId),
    fixtureId: assignment.fixtureId,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    cleanupId: assignment.cleanupId,
  }));
  const remaining = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-backlog-installed" && expectedRemainingBacklogIds.includes(assignment.surfaceId))
    .map((assignment) => assignment.surfaceId)
    .sort();
  assert.deepEqual(remaining, expectedRemainingBacklogIds);
  assert(plan.assignments.some((assignment) => (
    assignment.surfaceId === "ui-control:src/components/ConnectionEditor.tsx:[data-debug-id=\"connection-ssh-key-select\"]@src/components/ConnectionEditor.tsx#9"
    && assignment.driverId === "ui-control-bounded-installed"
    && assignment.fixtureId === "ui:connection-editor-owned-vault-key"
    && assignment.oracleId === "ui:choice-state-transition"
  )));
  assert(plan.assignments.some((assignment) => (
    assignment.surfaceId === "ui-debug-surface:connection-agent-cli-setup-open@src/components/ConnectionEditor.tsx#13"
    && assignment.driverId === "ui-debug-surface-installed"
    && assignment.fixtureId === "ui:owned-connection-editor-scanned-visible"
  )));
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
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
  const requestPath = join(temp, "connection-request.json");
  const reportPath = join(temp, "connection-report.json");
  writeFileSync(requestPath, `${JSON.stringify(requestValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint), "--request", requestPath, "--out", reportPath,
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("connection fixture exited before startup");
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("connection fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
