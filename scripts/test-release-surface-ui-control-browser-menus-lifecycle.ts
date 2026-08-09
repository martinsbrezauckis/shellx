import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  exerciseBrowserPersonalLockControl,
  supportsBrowserPersonalLockControl,
} from "./release-drivers/ui-control-browser-personal-lock-settings";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-browser-menus-"));
const profileRoot = join(temp, `shellx-final-browser-menus-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-browser-menus-token-0001";
const sessionId = "fixture-browser-menus-session-0001";
const instanceId = "fixture-browser-menus-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const promotedNames = new Set([
  "src/browser/components/BrowserMenus.tsx::is([data-debug-id=\"shellx-browser-personal-enable-now\"],[data-debug-id=\"shellx-browser-personal-lock-now\"],[data-debug-id=\"shellx-browser-personal-unlock-now\"])",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-enabled\"]",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-blur\"]",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-pause-delegated\"]",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-sleep\"]",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-minimize\"]",
  "src/browser/components/BrowserMenus.tsx:[data-debug-id=\"shellx-browser-personal-lock-set-pin\"]",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-notice-unlock\"]",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-pin\"]",
  "src/components/ShellxBrowserApp.tsx:[data-debug-id=\"shellx-browser-personal-lock-overlay-unlock\"]",
  "shellx-browser-personal-lock-now",
  "shellx-browser-personal-unlock-now",
  "shellx-browser-personal-lock-pin",
  "shellx-browser-personal-lock-set-pin",
  "shellx-browser-personal-lock-notice",
  "shellx-browser-personal-lock-notice-unlock",
  "shellx-browser-personal-lock-overlay",
  "shellx-browser-personal-lock-overlay-pin",
  "shellx-browser-personal-lock-overlay-unlock",
]);

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
  const request = createRequest(candidateBase, webdriverBase);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });

  assert.equal(request.assignments.length, 19);
  assert(request.assignments.every(supportsBrowserPersonalLockControl));
  const unlockAssignments = request.assignments.filter((assignment) => (
    assignment.surface.source === "src/components/ShellxBrowserApp.tsx"
  ));
  assert.equal(unlockAssignments.length, 8);
  assert(unlockAssignments.every((assignment) => (
    assignment.fixtureId === "ui:browser-personal-lock-owned-settings"
    && (
      assignment.oracleId === "ui:activation:browser-personal-lock-unlocked"
      || assignment.oracleId === "ui:activation:browser-personal-lock-pin-lifecycle"
      || assignment.oracleId === "ui:value-state-transition"
    )
    && assignment.cleanupId === "ui:restore-browser-personal-lock-settings-abort-task-and-window"
  )));
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseBrowserPersonalLockControl(
      { base: candidateBase, token },
      input,
      assignment,
    ));
  }
  assert(outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(outcomes, null, 2));

  const response = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const audit = await response.json() as {
    activeTaskId: string | null;
    browserTaskId: string | null;
    browserTaskTabId: string | null;
    activeTaskStatus: string | null;
    browserDisclosure: string | null;
    browserWindowOpen: boolean;
    currentWindow: string;
    browserPersonalLock: Record<string, unknown>;
    browserPersonalLockPinDraft: string;
    browserPersonalLockNotice: boolean;
    browserPersonalLockVerifierConfigured: boolean;
    browserPersonalTabId: string | null;
  };
  assert.equal(audit.activeTaskId, null);
  assert.equal(typeof audit.browserTaskId, "string");
  assert.equal(audit.browserTaskTabId, null);
  assert.equal(audit.activeTaskStatus, "aborted");
  assert.equal(audit.browserDisclosure, null);
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.deepEqual(audit.browserPersonalLock, {
    enabled: false,
    locked: false,
    timeoutMinutes: 30,
    authMode: "deviceAuthPreferred",
    pinConfigured: false,
    blurLockedTabs: true,
    pauseDelegatedTabsWhenLocked: true,
    lockOnSleep: true,
    lockOnMinimize: false,
  });
  assert.equal(audit.browserPersonalLockPinDraft, "");
  assert.equal(audit.browserPersonalLockNotice, false);
  assert.equal(audit.browserPersonalLockVerifierConfigured, false);
  assert.equal(audit.browserPersonalTabId, null);
  const retainedEvidence = JSON.stringify({ outcomes, audit, fixtureState: readFileSync(statePath, "utf8") });
  assert(!retainedEvidence.includes("539174"), "synthetic PIN must not enter API, audit, state, or outcome evidence");

  console.log("Release surface Browser Personal Lock tests passed (19 native controls/markers; PIN-free evidence and exact cleanup)");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string): ReleaseSurfaceDriverRequest {
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
    .filter((assignment) => (
      assignment.driverId === "ui-control-installed"
      || assignment.driverId === "ui-control-bounded-installed"
      || assignment.driverId === "ui-debug-browser-personal-lock-lifecycle-installed"
    ))
    .map((assignment) => ({ assignment, surface: requiredSurface(surfaceById, assignment.surfaceId) }))
    .filter(({ surface }) => promotedNames.has(surface.name))
    .map(({ assignment, surface }) => ({
      surface,
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-installed.ts", [
      "scripts/shellx-browser-test-cleanup.ts",
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
      "scripts/release-drivers/ui-control-browser-personal-lock-settings.ts",
    ]),
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
}

function requiredSurface(surfaceById: Map<string, ReleaseSurfaceItem>, id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  if (!surface) throw new Error(`missing inventory surface ${id}`);
  return surface;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Browser menu fixture exited before startup: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: unknown; webdriverPort?: unknown };
      if (typeof parsed.candidatePort === "number" && typeof parsed.webdriverPort === "number") {
        return { candidatePort: parsed.candidatePort, webdriverPort: parsed.webdriverPort };
      }
    } catch {
      // The fixture writes the state file atomically after both loopback servers listen.
    }
    await delay(25);
  }
  throw new Error("Browser menu fixture did not publish its ports");
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
