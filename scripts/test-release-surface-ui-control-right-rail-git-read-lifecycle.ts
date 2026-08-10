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
import { exerciseRightRailGitReadLifecycle } from "./release-drivers/ui-control-right-rail-git-read-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-right-rail-git-read-"));
const profileRoot = join(temp, `shellx-final-right-rail-git-${"d".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-right-rail-git-read-token-0001";
const sessionId = "fixture-right-rail-git-read-session-0001";
const instanceId = "fixture-right-rail-git-read-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-right-rail-git-read-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "src/lib/debug-right-rail-git-fixture.ts",
  "scripts/release-drivers/ui-control-right-rail-git-read-lifecycle.ts",
];
const exactNames = new Set([
  'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-1"]',
  'src/components/GitPane.tsx:[data-debug-id="surface-components-gitpane-5"]',
  'src/components/GitPane.tsx:role=button;name="Review diff"',
  'src/components/RightRail.tsx:[title^="Refresh model instruction cards — "][title$=" completed in this view"]',
  'src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-9"]',
  'src/components/RightRail.tsx:role=button;name="Trace"',
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
    id: string;
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, "ui-control-right-rail-git-read-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:right-rail-git-owned-read-lifecycle"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:clear-owned-right-rail-git-fixture-and-restore-right-rail"]);
  assert.equal(manifest.supportedOracles.length, 6);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = await exerciseRightRailGitReadLifecycle(
    { base: candidateBase, token },
    installedInput,
    request.assignments,
  );
  assert.equal(outcomes.length, 6);
  assert(outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  )), JSON.stringify(outcomes, null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    rightTab: string;
    activeTab: { tabId?: string };
    rightRailGitLifecycleActive: boolean;
    rightRailGitRefreshSequence: number;
    rightRailGitDiffScope: string;
    rightRailGitDiffVisible: boolean;
    rightRailModelCardsRefreshSequence: number;
    rightRailEnvironmentRefreshSequence: number;
    rightRailEnvironmentTraceReceipt: string | null;
    clickedSelectors: string[];
  };
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.rightRailGitLifecycleActive, false);
  assert.equal(audit.rightRailGitRefreshSequence, 0);
  assert.equal(audit.rightRailGitDiffScope, "head");
  assert.equal(audit.rightRailGitDiffVisible, false);
  assert.equal(audit.rightRailModelCardsRefreshSequence, 0);
  assert.equal(audit.rightRailEnvironmentRefreshSequence, 0);
  assert.equal(audit.rightRailEnvironmentTraceReceipt, null);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='surface-components-gitpane-1']").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-shellx-release-control='git-review-diff']").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector.includes("data-git-diff-scope=")).length, 4);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-shellx-release-control='model-cards-refresh']").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='surface-components-rightrail-9']").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-release-environment-control='trace']").length, 1);

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const excluded = plan.assignments.filter((assignment) => (
    (assignment.surfaceId.includes("src/components/RightRail.tsx")
      || assignment.surfaceId.includes("src/components/GitPane.tsx"))
    && assignment.driverId.endsWith("-backlog-installed")
    && assignment.fixtureId === "ui:right-rail-git-excluded-network-provider-clipboard-file-or-repository-state"
  ));
  assert.deepEqual(excluded, []);

  console.log("Release surface RightRail/GitPane read lifecycle passed: 6 reversible controls, 1 provider action, 1 owned clipboard control, and 0 BUILDING exclusions");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

// The final pretest chain already owns this RightRail/GitPane test entrypoint;
// keep the paired real repository-mutation lifecycle inseparable from it.
await import("./test-release-surface-ui-control-right-rail-git-write-lifecycle");

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-right-rail-git-read-lifecycle-installed")
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `RightRail/GitPane assignment ${assignment.surfaceId} must exist in the exact inventory`);
      assert(exactNames.has(surface.name), `unexpected RightRail/GitPane surface ${surface.name}`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 6);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-right-rail-git-read-lifecycle-installed",
    driverKind: "ui-control",
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
      evidence: { basename: "native-webdriver-binding.json", sha256: "a".repeat(64), bytes: 1024 },
    },
    assignments,
  };
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`RightRail/GitPane fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("RightRail/GitPane fixture did not publish its ports");
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
