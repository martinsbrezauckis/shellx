import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { exercisePermissionDecisionControls } from "./release-drivers/ui-permission-decision-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-permission-decision-"));
const profileRoot = join(temp, "shellx-final-permission-" + "p".repeat(16));
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-permission-decision-token-0001";
const sessionId = "fixture-permission-decision-session-0001";
const instanceId = "fixture-permission-decision-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "src/lib/debug-permission-decision-fixture.ts",
  "scripts/release-drivers/ui-permission-decision-lifecycle.ts",
];
const controlNames = new Set([
  'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-1"]',
  'src/components/PermissionPill.tsx:[data-debug-id="surface-components-permissionpill-3"]',
  'src/components/PermissionPill.tsx:[title="Allow this tool every time without asking"]',
]);
let fixture: ChildProcess | null = null;
try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
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
  const candidateBase = "http://127.0.0.1:" + ports.candidatePort;
  const webdriverBase = "http://127.0.0.1:" + ports.webdriverPort;

  assertManifest(
    "scripts/release-drivers/ui-control-permission-decision-lifecycle-installed.ts",
    "ui-control-permission-decision-lifecycle-installed",
    3,
  );

  const controlRequest = createRequest(
    candidateBase,
    webdriverBase,
    ports.candidatePort,
    "ui-control-permission-decision-lifecycle-installed",
    "ui-control",
    controlNames,
  );
  const installedInput = createReleaseSurfaceInstalledInputSession(
    controlRequest,
    { base: candidateBase, token },
  );
  const controlOutcomes = await exercisePermissionDecisionControls(
    { base: candidateBase, token },
    installedInput,
    controlRequest.assignments,
  );
  assert.equal(controlOutcomes.length, 3);
  assert(controlOutcomes.every(passed), JSON.stringify(controlOutcomes, null, 2));

  const auditResponse = await fetch(candidateBase + "/audit", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    bottomTab: string;
    activeTab: { tabId?: string };
    permissionFixtureAction: string | null;
    permissionDecision: string | null;
    clickedSelectors: string[];
  };
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.permissionFixtureAction, null);
  assert.equal(audit.permissionDecision, null);
  const permissionClicks = audit.clickedSelectors.filter((selector) => (
    selector.includes("permissionpill")
    || selector.includes("permission-pill")
  ));
  assert.equal(permissionClicks.length, 3);

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const permissionAssignments = plan.assignments.filter((assignment) => (
    assignment.surfaceId.includes("@src/components/PermissionPill.tsx")
  ));
  assert.equal(permissionAssignments.length, 5);
  assert.equal(permissionAssignments.filter((assignment) => (
    assignment.driverId === "ui-control-permission-decision-lifecycle-installed"
  )).length, 3);
  assert.equal(permissionAssignments.filter((assignment) => (
    assignment.driverId === "ui-debug-surface-installed"
  )).length, 2);
  assert.equal(permissionAssignments.filter((assignment) => (
    assignment.driverId.endsWith("-backlog-installed")
  )).length, 0);

  console.log("Permission decision lifecycle passed: 3 native pill transitions, 2 passive pill markers, 0 backlog");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function assertManifest(entrypoint: string, id: string, fixtureCount: number): void {
  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
  };
  assert.equal(manifest.id, id);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.equal(manifest.supportedFixtures.length, fixtureCount);
}

function createRequest(
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
  driverId: string,
  driverKind: "ui-control" | "ui-debug-surface",
  exactNames: Set<string>,
): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === driverId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, "permission assignment must exist in the exact inventory");
      assert(exactNames.has(surface.name), "unexpected permission surface " + surface.name);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, exactNames.size);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind,
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "d".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "e".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "f".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "e".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: {
        basename: "native-webdriver-binding.json",
        sha256: "a".repeat(64),
        bytes: 1024,
      },
    },
    assignments,
  };
}

function passed(outcome: {
  present: string;
  invoke: string;
  effect: string;
  cleanup: string;
  error?: string;
}): boolean {
  return outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{
  candidatePort: number;
  webdriverPort: number;
}> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("permission fixture exited before startup: " + await streamText(child.stderr));
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        candidatePort?: number;
        webdriverPort?: number;
      };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return {
          candidatePort: Number(value.candidatePort),
          webdriverPort: Number(value.webdriverPort),
        };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("permission fixture did not publish its ports");
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
