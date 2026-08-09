import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { exerciseBottomTabControl } from "./release-drivers/ui-control-bottom-tabs";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-bottom-tabs-"));
const profileRoot = join(temp, `shellx-final-bottom-tabs-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-bottom-tabs-token-0001";
const sessionId = "fixture-bottom-tabs-session-0001";
const instanceId = "fixture-bottom-tabs-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-bottom-tabs-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-bottom-tabs.ts",
];

let fixture: ChildProcess | null = null;
const stop = (): void => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
};
const onTerminationSignal = (): never => {
  stop();
  rmSync(temp, { recursive: true, force: true });
  process.exit(143);
};
process.once("SIGINT", onTerminationSignal);
process.once("SIGTERM", onTerminationSignal);

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

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, entrypoint), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id?: string;
    invocationTransport?: string;
    supportedFixtures?: string[];
    supportedCleanups?: string[];
    supportedOracles?: string[];
    controllerFiles?: string[];
  };
  assert.equal(manifest.id, "ui-control-bottom-tabs-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, ["ui:bottom-tab-opposite-baseline"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:restore-bottom-tab-baseline"]);
  assert.equal(manifest.supportedOracles?.length, 6);
  assert.deepEqual(manifest.controllerFiles, controllerFiles);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseBottomTabControl({ base: candidateBase, token }, input, assignment));
  }
  assert.equal(outcomes.length, 6);
  assert(outcomes.every((outcome) => outcome.present === "pass"));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"));
  assert(outcomes.every((outcome) => outcome.effect === "pass"));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"));

  console.log("Release surface native bottom-tab tests passed (6 controls)");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  stop();
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
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
    .filter((assignment) => assignment.driverId === "ui-control-bottom-tabs-installed")
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  assert.equal(assignments.length, 6);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bottom-tabs-installed",
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

function requiredSurface(surfaceById: Map<string, ReleaseSurfaceItem>, id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  assert(surface, `surface inventory is missing ${id}`);
  return surface;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`bottom-tab fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("bottom-tab fixture did not publish its ports");
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
