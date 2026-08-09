import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { nativePathInsideContainer } from "./release-drivers/ui-control-right-rail-git-write-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-right-rail-git-write-"));
const profileRoot = join(temp, `shellx-final-right-rail-git-write-${"w".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-right-rail-git-write-token-0001";
const sessionId = "fixture-right-rail-git-write-session-0001";
const instanceId = "fixture-right-rail-git-write-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "ui-control-right-rail-git-write-lifecycle-installed";
const entrypoint = "scripts/release-drivers/ui-control-right-rail-git-write-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/debug-api-session-fixture.ts",
  "scripts/release-drivers/ui-control-work-preview-start.ts",
  "scripts/release-drivers/ui-control-right-rail-git-write-lifecycle.ts",
];
const exactNames = new Set([
  'src/components/GitPane.tsx:role=button;name="Checkpoint"',
  'src/components/GitPane.tsx:role=button;name="Worktree"',
]);

let fixture: ChildProcess | null = null;
try {
  if (process.platform !== "win32") {
    const canonicalRoot = join(temp, "canonical-root");
    const aliasRoot = join(temp, "alias-root");
    const canonicalChild = join(canonicalRoot, ".worktrees", "child");
    mkdirSync(canonicalChild, { recursive: true });
    symlinkSync(canonicalRoot, aliasRoot, "dir");
    assert.equal(
      nativePathInsideContainer(canonicalChild, join(aliasRoot, ".worktrees")),
      true,
      "worktree containment must compare canonical paths across native aliases such as macOS /var and /private/var",
    );
  }
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
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:right-rail-git-owned-write-lifecycle"]);
  assert.deepEqual(manifest.supportedCleanups, [
    "ui:remove-owned-checkpoint-worktree-branch-and-repository-restore-right-rail",
  ]);
  assert.deepEqual(new Set(manifest.supportedOracles), new Set([
    "ui:activation:owned-git-checkpoint-created",
    "ui:activation:owned-git-worktree-created",
  ]));

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint), "--request", requestPath, "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((item) => item.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 2);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.startsWith("Native installed input")
  )), JSON.stringify(report.outcomes, null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    rightTab: string;
    activeTab: { tabId?: string; cwd?: string };
    rightRailGitWriteCheckpointCount: number;
    rightRailGitWriteWorktreeCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.activeTab.cwd, "/fixture/original-cwd");
  assert.equal(audit.rightRailGitWriteCheckpointCount, 1);
  assert.equal(audit.rightRailGitWriteWorktreeCount, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === ".git-actions > button:nth-child(2)").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === ".git-actions > button:nth-child(3)").length, 1);
  assert.equal(existsSync(join(profileRoot, "ui-right-rail-git-write-lifecycle")), false);
  assert.equal(existsSync(join(shellxHome, "git-checkpoints")), false);

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const remaining = plan.assignments.filter((assignment) => (
    assignment.fixtureId === "ui:right-rail-git-excluded-network-provider-clipboard-file-or-repository-state"
    && assignment.driverId.endsWith("-backlog-installed")
  ));
  assert.deepEqual(remaining, []);
  console.log("Release surface RightRail/GitPane write lifecycle passed: 2 real disposable repository mutations, exact cleanup, 0 remaining exclusions");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === driverId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Git write assignment ${assignment.surfaceId} must exist in the exact inventory`);
      assert(exactNames.has(surface.name), `unexpected Git write surface ${surface.name}`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 2);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "b".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(entrypoint, controllerFiles),
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "c".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "d".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "c".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "e".repeat(64), bytes: 1024 },
    },
    assignments,
  };
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Git write fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch {
      // Create-only state file is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Git write fixture did not publish its ports");
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
