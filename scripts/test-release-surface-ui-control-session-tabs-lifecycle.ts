import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { exerciseSessionTabsLifecycle } from "./release-drivers/ui-control-session-tabs-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-session-tabs-lifecycle-"));
const profileRoot = join(temp, `shellx-final-session-tabs-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-session-tabs-lifecycle-token-0001";
const sessionId = "fixture-session-tabs-lifecycle-session-0001";
const instanceId = "fixture-session-tabs-lifecycle-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-session-tabs-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-session-tabs-lifecycle.ts",
];
const exactSelectors = new Set([
  "[aria-label=\"All sessions\"]",
  "[aria-label=\"Close session\"]",
  "[aria-label=\"Rename session\"]",
  "[aria-label=\"Scroll left\"]",
  "[aria-label=\"Scroll right\"]",
  "[data-debug-id=\"session-rename-input\"]",
  "[data-debug-id=\"session-tab\"]",
  "[data-debug-id=\"surface-components-sessiontabs-11\"]",
  "[data-debug-id=\"surface-components-sessiontabs-4\"]",
  "[title^=\"#\"]",
  "[title=\"Close\"]",
  "[aria-label=\"New session\"]",
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
  assert.equal(manifest.id, "ui-control-session-tabs-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:session-tabs-owned-multi-tab-lifecycle"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:delete-owned-session-tabs-and-restore-baseline"]);
  assert.equal(manifest.supportedOracles.length, 12);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = await exerciseSessionTabsLifecycle(
    { base: candidateBase, token },
    installedInput,
    request.assignments,
    request.sourceCommit,
  );
  assert.equal(outcomes.length, 12);
  assert(outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  )), JSON.stringify(outcomes, null, 2));
  assert(outcomes.find((outcome) => outcome.oracleId.endsWith("scroll-right-position"))?.observedEffect.includes("scrollLeft increased"));
  assert(outcomes.find((outcome) => outcome.oracleId.endsWith("scroll-left-position"))?.observedEffect.includes("scrollLeft decreased"));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    activeTab: { tabId?: string };
    sessionTabIds: string[];
    sessionTabTitles: Array<string | null>;
    sessionDropdownOpen: boolean;
    sessionRenamingTabId: string | null;
    sessionRenameValue: string;
    sessionRailScrollLeft: number;
    previewTarget: unknown;
    ownedModalOpen: string | null;
    clickedSelectors: string[];
  };
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.deepEqual(audit.sessionTabIds, ["fixture-active-tab-035"]);
  assert.deepEqual(audit.sessionTabTitles, ["Fixture"]);
  assert.equal(audit.sessionDropdownOpen, false);
  assert.equal(audit.sessionRenamingTabId, null);
  assert.equal(audit.sessionRenameValue, "");
  assert.equal(audit.sessionRailScrollLeft, 0);
  assert.equal(audit.previewTarget, null);
  assert.equal(audit.ownedModalOpen, null);
  for (const selector of [
    "[aria-label='New session']",
    "[aria-label='All sessions']",
    "[aria-label='Scroll right']",
    "[aria-label='Scroll left']",
  ]) assert(audit.clickedSelectors.includes(selector), `fixture did not observe ${selector}`);
  assert(audit.clickedSelectors.some((selector) => selector.includes("[aria-label='Rename session']")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("[data-debug-id='surface-components-sessiontabs-4']")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("[data-debug-id='surface-components-sessiontabs-11']")));
  assert(audit.clickedSelectors.some((selector) => selector.includes("[role='option']:nth-child") && selector.endsWith("[title='Close']")));

  console.log("Release surface Session Tabs lifecycle passed: 12 exact controls, owned rollback, and real scroll metrics");
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
    .filter((assignment) => assignment.driverId === "ui-control-session-tabs-lifecycle-installed")
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Session Tabs assignment ${assignment.surfaceId} must exist in the exact inventory`);
      assert(exactSelectors.has(surface.selector ?? ""), `unexpected Session Tabs selector ${surface.selector}`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 12);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 12);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-session-tabs-lifecycle-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
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

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Session Tabs fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Session Tabs fixture did not publish its ports");
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
