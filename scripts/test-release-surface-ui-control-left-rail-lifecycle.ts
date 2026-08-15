import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { readAppStyles } from "./lib/app-styles";
import {
  projectCollapseDefaults,
  reconcileProjectCollapse,
  toggleProjectCollapse,
} from "../src/lib/projectCollapse";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-left-rail-lifecycle-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-left-rail-lifecycle-token-0001";
const sessionId = "fixture-ui-left-rail-lifecycle-session-0001";
const instanceId = "fixture-ui-left-rail-lifecycle-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-left-rail-lifecycle-installed";
const ownedSessionId = "release_session_" + sourceCommit.slice(0, 16) + "_ui_left_rail_lifecycle";
const ownedSessionPath = join(shellxHome, "sessions", ownedSessionId + ".jsonl");
const userDataPath = join(shellxHome, "user-data.json");
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-webdriver-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/native/macos-release-input.swift",
  "scripts/release-drivers/debug-api-session-fixture.ts",
  "scripts/release-drivers/ui-control-left-rail-lifecycle.ts",
];
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const css = readAppStyles();
  const leftRailSource = readFileSync(join(root, "src/components/LeftRail.tsx"), "utf8");
  const lifecycleSource = readFileSync(join(root, "scripts/release-drivers/ui-control-left-rail-lifecycle.ts"), "utf8");
  assert.match(css, /\.left-hdr \.left-collapse-all\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.left-hdr \.plus-btn\s*\{[^}]*flex:\s*0 0 24px;/s);
  assert.match(css, /\.left-hdr \.plus-btn\s*\{[^}]*flex-basis:\s*28px;/s);
  assert.match(leftRailSource, /if \(!userDataReady\)\s*\{[\s\S]*data-user-data-ready="false"[\s\S]*aria-busy="true"/);
  assert.match(leftRailSource, /data-user-data-ready="true"[\s\S]*aria-busy="false"/);
  assert.match(lifecycleSource, /wait\(input, "\[data-debug-id='left-rail'\]\[data-user-data-ready='true'\]"\)/);
  assert.deepEqual(projectCollapseDefaults([{ id: "first" }, { id: "second" }], {}), { first: false, second: true });
  assert.deepEqual(toggleProjectCollapse({}, "fresh"), { fresh: false }, "a missing collapse key expands on its first click");
  assert.deepEqual(
    reconcileProjectCollapse([{ id: "fresh" }], { fresh: false }, { fresh: true }),
    { fresh: false },
    "post-render reconciliation preserves an immediate user expand",
  );
  const planned = plan.assignments.filter((assignment) => assignment.driverId === driverId);
  assert.equal(planned.length, 24, "left-rail lifecycle driver must own exactly 24 reversible controls");
  assert.equal(new Set(planned.map((assignment) => assignment.surfaceId)).size, 24);
  assert(planned.every((assignment) => assignment.fixtureId === "ui:left-rail-owned-lifecycle"));
  assert(planned.every((assignment) => assignment.cleanupId.includes("restore-left-rail-titles-assignments-active-tab")));
  assert(planned.some((assignment) => assignment.surfaceId.includes("permanently remove")));
  assert(planned.some((assignment) => assignment.surfaceId.endsWith("RowActions.tsx#2")));
  const driver = plan.drivers.find((entry) => entry.id === driverId);
  assert(driver, "left-rail lifecycle driver must exist");
  assert.deepEqual(driver.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });

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
    "--left-rail-lifecycle",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = "http://127.0.0.1:" + ports.candidatePort;
  const webdriverBase = "http://127.0.0.1:" + ports.webdriverPort;
  assert(existsSync(userDataPath), "fixture must publish an exact persisted baseline");
  const baselineUserData = readFileSync(userDataPath);

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/ui-control-left-rail-lifecycle-installed.ts",
      controllerFiles,
    ),
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
    assignments: planned.map((assignment) => {
      const surface = inventory.items.find((item) => item.id === assignment.surfaceId);
      assert(surface, "planned left-rail surface must remain in exact inventory");
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    }),
  };
  writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-left-rail-lifecycle-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:left-rail-owned-lifecycle"]);
  assert.equal(manifest.supportedCleanups.length, 1);
  assert.equal(manifest.supportedOracles.length, 21);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-left-rail-lifecycle-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 180_000 });
  const report = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport
    : null;
  const failures = report?.outcomes.filter((outcome) => outcome.error) ?? [];
  assert.equal(run.status, 0, [run.stderr, failures.length ? JSON.stringify(failures, null, 2) : run.stdout].filter(Boolean).join("\n"));
  assert(report);
  assert.equal(report.outcomes.length, 24);
  assert(report.outcomes.every((outcome) =>
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  ));
  assert.equal(new Set(report.outcomes.map((outcome) => outcome.oracleId)).size, 21);
  assert.equal(existsSync(ownedSessionPath), false, "owned JSONL must be deleted");
  assert.deepEqual(readFileSync(userDataPath), baselineUserData, "persisted user data must be byte-exactly restored");

  const state = await fetch(candidateBase + "/state/ui", { headers: { Authorization: "Bearer " + token } });
  assert.equal(state.status, 200);
  const ui = await state.json() as { activeTabId?: unknown; openTabs?: Array<Record<string, unknown>> };
  assert.equal(ui.activeTabId, "fixture-active-tab-035");
  assert.deepEqual(ui.openTabs?.map((tab) => tab.tabId), ["fixture-active-tab-035"]);

  console.log("Release surface left-rail lifecycle controls passed: 24 exact reversible assignments");
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
      throw new Error("left-rail fixture exited before startup: " + await streamText(child.stderr));
    }
    await delay(25);
  }
  throw new Error("left-rail fixture did not publish its ports");
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
