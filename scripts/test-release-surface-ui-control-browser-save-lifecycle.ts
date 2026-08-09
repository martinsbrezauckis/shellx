import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { executeBrowserSaveLifecycle } from "./release-drivers/ui-control-browser-save-lifecycle-installed";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-browser-save-"));
const profileRoot = join(temp, `shellx-final-browser-save-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-browser-save-token-0001";
const sessionId = "fixture-browser-save-session-0001";
const instanceId = "fixture-browser-save-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-browser-save-lifecycle-installed";
const exactNames = new Set([
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-fullpage-screenshot"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-screenshot"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-markdown"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-links"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-snapshot"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-media"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-code"]',
  'src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-site"]',
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
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const described = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/release-drivers/ui-control-browser-save-lifecycle-installed.ts"),
    "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    invocationTransport: string;
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, ["ui:browser-save-owned-page-and-download-folder"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:close-owned-browser-task-with-candidate-teardown"]);
  assert.deepEqual(manifest.supportedOracles, ["ui:activation:browser-save-artifact-or-intent-recorded"]);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const report = await executeBrowserSaveLifecycle(request);
  assert.equal(report.outcomes.length, 8);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
      && outcome.invoke === "pass"
      && outcome.effect === "pass"
      && outcome.cleanup === "pass"
      && !outcome.error
  )), JSON.stringify(report.outcomes, null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    browserDownloadFolder: string | null;
    browserDownloads: Array<Record<string, unknown>>;
    activeTaskId: string | null;
    browserTaskId: string | null;
    browserTaskTabId: string | null;
    activeTaskStatus: string | null;
    browserWindowOpen: boolean;
    currentWindow: string;
    clickedSelectors: string[];
  };
  assert.equal(audit.browserDownloadFolder, null);
  assert.equal(audit.browserDownloads.length, 9);
  assert.equal(audit.browserDownloads.filter((entry) => entry.status === "completed").length, 6);
  assert.equal(audit.browserDownloads.filter((entry) => entry.status === "requested").length, 3);
  assert(audit.browserDownloads.every((entry) => (
    typeof entry.transferId === "string"
      && entry.taskId === audit.browserTaskId
      && entry.browserTabId !== null
      && (entry.finalPath === null || (typeof entry.finalPath === "string" && !existsSync(entry.finalPath)))
  )));
  assert.equal(audit.activeTaskId, null);
  assert.match(audit.browserTaskId ?? "", /^fixture-browser-task-/);
  assert.equal(audit.browserTaskTabId, null);
  assert.equal(audit.activeTaskStatus, "aborted");
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='shellx-browser-save-page']").length, 8);
  assert.equal(audit.clickedSelectors.filter((selector) => selector.startsWith("[data-debug-id='shellx-browser-save-")
    && selector !== "[data-debug-id='shellx-browser-save-page']").length, 8);

  const outputPath = join(shellxHome, `release-browser-save-${sourceCommit.slice(0, 16)}`);
  assert.equal(existsSync(outputPath), false);
  console.log("Browser Save lifecycle passed: 8 exact native actions, 6 verified/deleted artifacts, 3 queued intents, 9 monotonic rows isolated to candidate teardown");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId).map((assignment) => {
    const surface = inventoryById.get(assignment.surfaceId);
    assert(surface, "Browser Save assignment must exist in the inventory");
    assert(exactNames.has(surface.name), `unexpected Browser Save surface ${surface.name}`);
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
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
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
      throw new Error(`Browser Save fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch { /* create-only state may not exist yet */ }
    await delay(50);
  }
  throw new Error("Browser Save fixture did not publish its ports");
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
