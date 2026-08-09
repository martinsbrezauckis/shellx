import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceBoundedUiControlControllerBindingFixture,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-build-plan-review-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-build-plan-review-token-0001";
const sessionId = "fixture-ui-build-plan-review-session-0001";
const instanceId = "fixture-ui-build-plan-review-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureId = "ui:build-plan-review-owned-inert";
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
        && assignment.surfaceId.includes("src/components/BuildPlanReviewModal.tsx")
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Build plan review assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 4);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 4);

  const blocked = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.surfaceId.includes("src/components/BuildPlanReviewModal.tsx")
  ));
  assert.deepEqual(blocked, []);

  const modalSource = readFileSync(join(root, "src/components/BuildPlanReviewModal.tsx"), "utf8");
  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert(modalSource.includes("OWNED_DEBUG_PLAN_TEXT"));
  assert(modalSource.includes('debugFixture?: "owned-ready" | null'));
  assert(modalSource.includes('if (debugFixture === "owned-ready") return;'), "fixture must suppress Build state polling");
  assert(modalSource.includes('if (busy || debugFixture === "owned-ready" || !inTauri()) return;'), "fixture must suppress approve and reject handlers");
  assert(modalSource.includes("Confirm rejection and halt this Build Mode run"));
  assert(!modalSource.includes("window.confirm("));
  assert.equal(count(modalSource, 'disabled={busy !== null || debugFixture === "owned-ready"}'), 2);
  assert(appSource.includes('p.debugBuildPlanFixture === "owned-ready"'));
  assert(appSource.includes('p.debugBuildPlanFixture === "clear"'));

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

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
    controllerFiles: string[];
  };
  assert(manifest.supportedFixtures.includes(fixtureId));
  assert(manifest.supportedFixtures.includes("ui:build-plan-review-owned-approve"));
  assert(manifest.supportedFixtures.includes("ui:build-plan-review-owned-reject"));
  assert(manifest.supportedCleanups.includes("ui:clear-owned-build-plan-review-and-restore-right-rail"));
  assert(manifest.supportedOracles.includes("ui:activation:build-plan-review-dismissed"));
  assert(manifest.supportedOracles.includes("ui:activation:build-run-cockpit-owned-state-transition"));
  assert.equal(manifest.controllerFiles.filter((path) => path === "scripts/release-drivers/ui-control-build-plan-review-safe.ts").length, 1);

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
    assignments,
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 4);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && (outcome.observedEffect.includes("renderer-only Build plan review")
      || outcome.observedEffect.includes("Build Plan modal"))
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    rightTab: string;
    buildPlanFixtureActive: boolean;
    buildPlanReviewOpen: boolean;
    buildPlanUnsafeMutationCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.buildPlanFixtureActive, false);
  assert.equal(audit.buildPlanReviewOpen, false);
  assert.equal(audit.buildPlanUnsafeMutationCount, 0);
  assert.deepEqual(audit.clickedSelectors, [
    "[role='dialog'][aria-label^='Review build plan:'] [aria-label='Review later']",
    "[data-debug-id='surface-components-buildplanreviewmodal-4']",
    "[data-debug-id='surface-components-buildplanreviewmodal-4']",
    "[data-debug-id='surface-components-buildplanreviewmodal-5']",
    "[role='dialog'][aria-label^='Review build plan:'] .plan-review-actions > button:first-child",
  ]);

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "Build plan review evidence output must remain create-only");
  console.log("Build plan review native lifecycle passed: all 4 controls promoted with exact cleanup");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Build plan review fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // The create-only state file is not ready yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Build plan review fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
