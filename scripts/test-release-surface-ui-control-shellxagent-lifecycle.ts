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
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-shellxagent-lifecycle-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = ["01234567", "89abcdef", "01234567", "89abcdef"].join("");
const sessionId = "fixture-ui-shellxagent-session-0001";
const instanceId = "fixture-ui-shellxagent-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureId = "ui:shellxagent-owned-safe-token";
const promotedSurfaceIds = [
  "ui-control:src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]@src/components/settings/ShellxagentTab.tsx#1",
  "ui-control:src/components/settings/ShellxagentTab.tsx:[data-debug-id=\"surface-components-settings-shellxagenttab-3\"]@src/components/settings/ShellxagentTab.tsx#3",
] as const;
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const assignments = promotedSurfaceIds.map((surfaceId) => {
    const surface = inventory.items.find((item) => item.id === surfaceId);
    const planned = plan.assignments.find((assignment) => assignment.surfaceId === surfaceId);
    assert(surface, `promoted ShellX Agent surface must exist in the exact inventory: ${surfaceId}`);
    assert(planned, `promoted ShellX Agent surface must exist in the exact plan: ${surfaceId}`);
    assert.equal(planned.driverId, "ui-control-bounded-installed");
    return {
      surface,
      fixtureId: planned.fixtureId,
      expectedEffect: planned.expectedEffect,
      oracleId: planned.oracleId,
      cleanupId: planned.cleanupId,
    };
  });
  assert.equal(assignments[0]?.fixtureId, fixtureId);
  assert.equal(assignments[0]?.oracleId, "ui:boolean-state-transition");
  assert.equal(assignments[0]?.cleanupId, "ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture");
  assert.equal(assignments[1]?.fixtureId, "ui:shellxagent-isolated-token-rotation");
  assert.equal(assignments[1]?.oracleId, "ui:activation:shellxagent-token-file-rotated");
  assert.equal(assignments[1]?.cleanupId, "ui:restore-isolated-shellxagent-token-mode-and-settings");

  const blocked = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.surfaceId.includes("src/components/settings/ShellxagentTab.tsx")
  ));
  assert.deepEqual(blocked, [], "all non-clipboard ShellX Agent controls must have executable lanes");

  const tabSource = readFileSync(join(root, "src/components/settings/ShellxagentTab.tsx"), "utf8");
  const settingsSource = readFileSync(join(root, "src/components/Settings.tsx"), "utf8");
  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  assert(tabSource.includes('debugFixture?: ShellxagentDebugFixture'));
  assert(tabSource.includes('disabled={!token || (fixtureActive && !clipboardFixtureActive)}'));
  assert(tabSource.includes('disabled={loading || !desktopAgentAvailable || fixtureActive}'));
  assert(tabSource.includes('data-shellx-release-observe="pressed"'));
  assert.equal(count(tabSource, 'data-shellx-release-observe="disabled"'), 2);
  assert(settingsSource.includes('debugShellxagentFixture === "owned-safe"'));
  assert(settingsSource.includes('const renderedTab: SettingsTab'));
  assert(appSource.includes('p.debugShellxagentFixture === "owned-safe"'));
  assert(appSource.includes('p.debugShellxagentFixture === "clear"'));

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
  assert(manifest.supportedCleanups.includes("ui:hide-owned-shellxagent-token-close-settings-and-clear-fixture"));
  assert(manifest.supportedOracles.includes("ui:boolean-state-transition"));
  assert.equal(manifest.controllerFiles.filter((path) => path === "scripts/release-drivers/ui-control-shellxagent-lifecycle.ts").length, 1);

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
  assert.equal(report.outcomes.length, 2);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && (outcome.observedEffect.includes("fixed renderer-owned ShellX Agent token")
      || outcome.observedEffect.includes("credential file to a different 32-hex SHA-256 identity"))
  )));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    settingsOpen: boolean;
    settingsTab: string;
    shellxagentFixtureActive: boolean;
    shellxagentRevealed: boolean;
    shellxagentUnsafeMutationCount: number;
    shellxagentRotationCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.settingsTab, "general", "the operator Settings tab baseline must remain untouched");
  assert.equal(audit.shellxagentFixtureActive, false);
  assert.equal(audit.shellxagentRevealed, false);
  assert.equal(audit.shellxagentUnsafeMutationCount, 0);
  assert.equal(audit.shellxagentRotationCount, 1);
  assert.equal(readFileSync(tokenPath, "utf8"), token, "the live-shaped credential file must remain byte-for-byte unchanged");
  assert(!JSON.stringify(report).includes(token), "the synthetic credential must not enter release evidence");
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-settings-shellxagenttab-3']"));

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "ShellX Agent lifecycle evidence output must remain create-only");
  console.log("ShellX Agent native lifecycle passed: reveal, isolated token rotation, and owned clipboard coverage with zero BUILDING rows");
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
      throw new Error(`ShellX Agent fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("ShellX Agent fixture did not publish its ports");
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
