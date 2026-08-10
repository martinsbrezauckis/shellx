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
  ACTIVITY_BROWSER_LIFECYCLE_CLEANUPS,
  ACTIVITY_BROWSER_LIFECYCLE_FIXTURES,
  ACTIVITY_BROWSER_LIFECYCLE_ORACLES,
  exerciseActivityBrowserLifecycleControl,
} from "./release-drivers/ui-control-activity-browser-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-activity-browser-"));
const profileRoot = join(temp, `shellx-final-activity-browser-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-activity-browser-token-0001";
const sessionId = "fixture-activity-browser-session-0001";
const instanceId = "fixture-activity-browser-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-activity-browser-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-activity-browser-lifecycle.ts",
];

let fixture: ChildProcess | null = null;
try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/fixtures/release-surface-ui-control-activity-browser-lifecycle-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token-file", tokenPath,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
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
  assert.equal(manifest.id, "ui-control-activity-browser-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, [...ACTIVITY_BROWSER_LIFECYCLE_FIXTURES]);
  assert.deepEqual(manifest.supportedCleanups, [...ACTIVITY_BROWSER_LIFECYCLE_CLEANUPS]);
  assert.deepEqual(manifest.supportedOracles, [...ACTIVITY_BROWSER_LIFECYCLE_ORACLES]);
  assert.deepEqual(manifest.controllerFiles, controllerFiles);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseActivityBrowserLifecycleControl(
      { base: candidateBase, token },
      input,
      request,
      assignment,
    ));
  }
  assert.equal(outcomes.length, 8);
  assert(outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => !outcome.observedEffect.includes("SHELLX_RELEASE_ACTIVITY_CANARY")));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    openTabs: Array<Record<string, unknown>>;
    activeTabId: string;
    preview: unknown;
    modal: string;
    findOpen: boolean;
    query: string;
    rowSelected: boolean;
    customGraphPosition: boolean;
    nestedExpanded: boolean;
    previewTransitions: number;
    resetTransitions: number;
    selectionTransitions: number;
    expandTransitions: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.openTabs.length, 1);
  assert.equal(audit.openTabs[0]?.tabId, "fixture-baseline-tab");
  assert.equal(audit.activeTabId, "fixture-baseline-tab");
  assert.equal(audit.preview, null);
  assert.equal(audit.modal, "none");
  assert.equal(audit.findOpen, false);
  assert.equal(audit.query, "");
  assert.equal(audit.rowSelected, false);
  assert.equal(audit.customGraphPosition, false);
  assert.equal(audit.nestedExpanded, false);
  assert.equal(audit.previewTransitions, 5);
  assert.equal(audit.resetTransitions, 1);
  assert.equal(audit.selectionTransitions, 4);
  assert.equal(audit.expandTransitions, 2);
  assert(audit.clickedSelectors.length > 30);

  console.log("Release surface Activity Browser lifecycle tests passed (8 controls; exact owned fixture cleanup)");
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
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-activity-browser-lifecycle-installed")
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
    driverId: "ui-control-activity-browser-lifecycle-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "a".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "b".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "c".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "b".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "d".repeat(64), bytes: 1024 },
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
      throw new Error(`Activity Browser fixture exited before startup (${String(child.exitCode)}/${String(child.signalCode)}): ${[
        await streamText(child.stderr),
        await streamText(child.stdout),
      ].filter(Boolean).join("\n")}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch { /* fixture state is not ready */ }
    await delay(50);
  }
  throw new Error("Activity Browser fixture did not publish its ports");
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
