import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceBoundedUiControlControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-find-new-tab-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-control-find-new-tab-token-0001";
const sessionId = "fixture-ui-control-find-new-tab-session-0001";
const instanceId = "fixture-ui-control-find-new-tab-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const surfaceId = "ui-control:src/components/FindPopover.tsx:[title=\"Open this chat in a new tab (Enter)\"]@src/components/FindPopover.tsx#5";
const ownedSessionId = `release_session_${sourceCommit.slice(0, 16)}_ui_find_new_tab`;
const ownedSessionPath = join(shellxHome, "sessions", `${ownedSessionId}.jsonl`);
const baselineTabId = "fixture-active-tab-035";
const controllerFiles = [
  "scripts/release-drivers/ui-control-installed.ts",
  "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
  ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
];
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const surface = inventory.items.find((item) => item.id === surfaceId);
  const planned = plan.assignments.find((assignment) => assignment.surfaceId === surfaceId);
  assert(surface, "Find new-tab surface must exist in the exact inventory");
  assert(planned, "Find new-tab surface must have an exact driver assignment");
  assert.equal(planned.driverId, "ui-control-bounded-installed");
  assert.equal(planned.fixtureId, "ui:find-owned-session-new-tab");
  assert.equal(planned.oracleId, "ui:activation:find-owned-session-new-tab");
  assert.equal(planned.cleanupId, "ui:close-owned-session-tab-delete-history-and-restore-baseline");
  const driver = plan.drivers.find((entry) => entry.id === "ui-control-bounded-installed");
  assert(driver, "bounded installed UI-control driver must exist");
  assert.equal(driver.platforms["windows-installed"], "ready");
  assert.equal(driver.platforms["linux-installed"], "ready");
  assert.equal(driver.platforms["macos-installed"], "ready");

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
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bounded-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceBoundedUiControlControllerBindingFixture(),
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
    assignments: [{
      surface,
      fixtureId: planned.fixtureId,
      expectedEffect: planned.expectedEffect,
      oracleId: planned.oracleId,
      cleanupId: planned.cleanupId,
    }],
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert(manifest.supportedFixtures.includes(planned.fixtureId));
  assert(manifest.supportedCleanups.includes(planned.cleanupId));
  assert(manifest.supportedOracles.includes(planned.oracleId));

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failure = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failure ? JSON.stringify(failure, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 1);
  assert.deepEqual(
    report.outcomes.map(({ present, invoke, effect, cleanup }) => ({ present, invoke, effect, cleanup })),
    [{ present: "pass", invoke: "pass", effect: "pass", cleanup: "pass" }],
  );
  assert.match(report.outcomes[0]!.observedEffect, /Native WebDriver activation opened exactly one new renderer tab/);

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    activeTab: Record<string, unknown>;
    sessionTabIds: string[];
    sessionTabSessionIds: Array<string | null>;
    clickedSelectors: string[];
    findSessionsFocused: boolean;
    alwaysVisibleTextValues: Record<string, string>;
    inputClearCounts: Record<string, number>;
    neutralFocusClicks: number;
  };
  assert.deepEqual(audit.sessionTabIds, [baselineTabId]);
  assert.deepEqual(audit.sessionTabSessionIds, [null]);
  assert.equal(audit.activeTab.tabId, baselineTabId);
  assert.deepEqual(audit.clickedSelectors, [
    "[data-debug-id='surface-components-findpopover-4']",
    "[title='Open this chat in a new tab (Enter)']",
    `[data-tab-id='fixture-find-owned-tab-${sourceCommit.slice(0, 16)}'] [aria-label='Close session']`,
  ]);
  assert.equal(audit.findSessionsFocused, false);
  assert.equal(audit.alwaysVisibleTextValues["[data-debug-id='find-sessions-input']"], "");
  assert.equal(audit.inputClearCounts["[data-debug-id='find-sessions-input']"], 2);
  assert.equal(audit.neutralFocusClicks, 2);
  assert.equal(existsSync(ownedSessionPath), false, "owned Find session JSONL must be deleted");

  console.log("Release surface Find new-tab native WebDriver control passed: 1 exact assignment");
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
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { candidatePort: number; webdriverPort: number };
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Find new-tab fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    await delay(25);
  }
  throw new Error("Find new-tab fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
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
