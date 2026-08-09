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
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-branch-picker-lifecycle-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-branch-picker-token-0001";
const sessionId = "fixture-branch-picker-session-0001";
const instanceId = "fixture-branch-picker-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-branch-picker-lifecycle-installed";
const entrypoint = "scripts/release-drivers/ui-control-branch-picker-lifecycle-installed.ts";
const OPTION_SELECTOR = "[data-debug-id='surface-components-branchpicker-1'][role='option']";
const ownedGitPath = join(shellxHome, "release-surface-git-" + sourceCommit.slice(0, 16));
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/debug-api-git-fixture.ts",
  "scripts/release-drivers/ui-control-branch-picker-lifecycle.ts",
];
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
  const candidateBase = "http://127.0.0.1:" + ports.candidatePort;
  const webdriverBase = "http://127.0.0.1:" + ports.webdriverPort;

  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as Record<string, unknown>;
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:owned-branch-picker-selection"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:close-owned-branch-picker-tab-delete-temp-git-and-restore-baseline"]);
  assert.deepEqual(manifest.supportedOracles, ["ui:selection-state-transition"]);

  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as {
    digest: string;
    items: ReleaseSurfaceItem[];
  };
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as {
    drivers: Array<{ id: string; platforms: Record<string, string> }>;
    assignments: Array<{
      surfaceId: string;
      driverId: string;
      fixtureId: string;
      expectedEffect: string;
      oracleId: string;
      cleanupId: string;
    }>;
  };
  const planned = plan.assignments.filter((assignment) => assignment.driverId === driverId);
  assert.equal(planned.length, 1);
  assert.equal(
    planned[0]?.surfaceId,
    'ui-control:src/components/BranchPicker.tsx:[data-debug-id="surface-components-branchpicker-1"]@src/components/BranchPicker.tsx#1',
  );
  assert.deepEqual(plan.drivers.find((driver) => driver.id === driverId)?.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });
  const surface = inventory.items.find((item) => item.id === planned[0]!.surfaceId);
  assert(surface);
  const request: ReleaseSurfaceDriverRequest = {
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
        port: ports.candidatePort,
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
      fixtureId: planned[0]!.fixtureId,
      expectedEffect: planned[0]!.expectedEffect,
      oracleId: planned[0]!.oracleId,
      cleanupId: planned[0]!.cleanupId,
    }],
  };
  writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint), "--request", requestPath, "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, [run.stderr, run.stdout, reportText].filter(Boolean).join("\n"));
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 1);
  assert(report.outcomes.every((outcome) => outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error), JSON.stringify(report.outcomes, null, 2));
  assert.equal(existsSync(ownedGitPath), false, "owned temporary Git repository must be deleted");

  const audit = await getJson<Record<string, unknown>>(candidateBase + "/audit", token);
  assert.equal(audit.composerPicker, null);
  const ui = await getJson<Record<string, unknown>>(candidateBase + "/state/ui", token);
  assert.deepEqual(
    (ui.openTabs as Array<Record<string, unknown>>).map((tab) => tab.tabId),
    ["fixture-active-tab-035"],
  );
  assert.equal(ui.activeTabId, "fixture-active-tab-035");
  assert((audit.clickedSelectors as string[]).includes(OPTION_SELECTOR));
  console.log("Release surface BranchPicker lifecycle passed: one owned Git selection with exact tab and repository cleanup");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

async function getJson<T>(url: string, bearer: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: "Bearer " + bearer } });
  if (!response.ok) throw new Error("fixture audit failed: " + response.status + " " + await response.text());
  return await response.json() as T;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("BranchPicker fixture exited before startup");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { candidatePort: number; webdriverPort: number };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("BranchPicker fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
