import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-command-webdriver-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-shellx-command-webdriver-token-0001";
const sessionId = "fixture-shellx-command-session-0001";
const instanceId = "fixture-shellx-command-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const commands = ["/commands", "/pr", "/pause", "/resume", "/stop", "/build", "/goal"];
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
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-shellx-command-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "shellx-command-installed",
    driverKind: "shellx-command",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/shellx-command-installed.ts", [
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
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
      posixNative: releaseSurfacePosixNativeBindingFixture({ processId: 4321, port: Number(new URL(candidateBase).port), imagePath: "/tmp/fixture/shellx", imageSha256: "d".repeat(64) }),
    },
    nativeWebDriver: {
      base: `http://127.0.0.1:${ports.webdriverPort}`,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments: commands.map((command) => ({
      surface: {
        id: `shellx-command:${command}`,
        kind: "shellx-command",
        name: command,
        source: "src/App.tsx",
        platforms: ["linux-installed", "windows-installed", "macos-installed"],
        delivery: "installed-app",
      },
      fixtureId: command === "/commands" || command === "/pr" || command === "/build" || command === "/goal"
        ? "shellx-command:composer-empty"
        : "shellx-command:owned-legacy-goal",
      expectedEffect: `${command} opens its exact visible effect`,
      oracleId: command === "/commands"
        ? "shellx-command:commands:palette-visible"
        : command === "/pr"
          ? "shellx-command:pr:dialog-visible"
          : command === "/build" || command === "/goal"
            ? `shellx-command:${command.slice(1)}:objective-required`
            : `shellx-command:${command.slice(1)}:goal-${command === "/stop" ? "cleared" : command.slice(1) + "d"}`,
      cleanupId: command === "/commands" || command === "/pr" || command === "/build" || command === "/goal"
        ? "shellx-command:close-modal-and-clear-composer"
        : "shellx-command:clear-owned-goal-and-delete-cwd",
    })),
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/shellx-command-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  assert.equal(JSON.parse(described.stdout).invocationTransport, "native-installed-input");

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/shellx-command-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, `${run.stderr || run.stdout}\n${readFileSync(reportPath, "utf8")}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, commands.length);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("native installed-input events")
  )));

  const audit = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as {
    enteredValues: string[];
    clickedCommands: string[];
    promptValue: string;
    activeCommand: string | null;
    clearCount: number;
    activeTab: { tabId: string; cwd: string };
    goalStates: Record<string, unknown>;
    apiRequests: string[];
  };
  assert.deepEqual(auditBody.clickedCommands, commands);
  assert.deepEqual(auditBody.enteredValues, commands);
  assert.equal(auditBody.clearCount, commands.length * 2, "each command clears the composer during setup and cleanup");
  assert.equal(auditBody.promptValue, "");
  assert.equal(auditBody.activeCommand, null);
  assert.equal(auditBody.activeTab.cwd, "/fixture/original");
  assert.deepEqual(auditBody.goalStates, {});
  assert.deepEqual(auditBody.apiRequests, [
    "GET /build/state", "GET /goal/state", "POST /goal/start", "GET /goal/state", "GET /goal/state", "POST /goal/stop", "GET /goal/state",
    "GET /build/state", "GET /goal/state", "POST /goal/start", "POST /goal/pause", "GET /goal/state", "GET /goal/state", "POST /goal/stop", "GET /goal/state",
    "GET /build/state", "GET /goal/state", "POST /goal/start", "GET /goal/state", "GET /goal/state", "POST /goal/stop", "GET /goal/state",
  ]);
  console.log("Release surface native ShellX command WebDriver tests passed");
} finally {
  process.off("SIGINT", onTerminationSignal);
  process.off("SIGTERM", onTerminationSignal);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`ShellX command fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("ShellX command fixture did not publish its ports");
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
