import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  probeReleaseSurfaceRuntimeCandidate,
  validateReleaseSurfaceRuntimeProbe,
} from "./lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA,
  collectReleaseSurfaceWindowsNativeRuntime,
  toReleaseSurfaceWindowsNativeBinding,
  validateReleaseSurfaceWindowsNativeRuntime,
  validateReleaseSurfaceWindowsRuntimeBinding,
  validateReleaseSurfaceWindowsRuntimeContinuity,
  validateReleaseSurfaceWindowsProbeOrder,
  type ReleaseSurfaceWindowsNativeRuntime,
} from "./lib/release-surface-windows-native-runtime";
import { releaseSourceOnlyRequested } from "./lib/release-source-test-mode";
import { syntheticReleaseSurfaceControllerBinding, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";

const fixture: ReleaseSurfaceWindowsNativeRuntime = {
  schema: RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA,
  collector: "windows-powershell-v1",
  orchestrator: "wsl",
  observedAt: "2026-07-28T20:00:00.000Z",
  osVersion: "Microsoft Windows NT 10.0.26100.0",
  architecture: "x64",
  process: {
    pid: 4321,
    startId: "2026-07-28T19:59:00.000Z",
    imagePath: "C:\\Program Files\\ShellX\\shellx.exe",
    imageSha256: "a".repeat(64),
    imageBytes: 1024,
    imageFileId: "abcd1234:0x00000000000000000000000000000001",
  },
  listener: { address: "127.0.0.1", port: 30123, owningPid: 4321 },
};
assert.deepEqual(validateReleaseSurfaceWindowsNativeRuntime(fixture, {
  processId: 4321,
  port: 30123,
  orchestrator: "wsl",
  imagePath: "c:/program files/shellx/shellx.exe",
  imageSha256: "a".repeat(64),
}), []);
const binding = toReleaseSurfaceWindowsNativeBinding(fixture);
assert.deepEqual(validateReleaseSurfaceWindowsRuntimeBinding(binding, fixture), []);
const restarted = structuredClone(fixture);
restarted.observedAt = "2026-07-28T20:00:01.000Z";
restarted.process.startId = "2026-07-28T20:00:00.500Z";
assert(
  validateReleaseSurfaceWindowsRuntimeContinuity(fixture, restarted)
    .some((error) => error.includes("binding changed")),
  "a reused PID from a different process epoch must not satisfy the native binding",
);
const replaced = structuredClone(fixture);
replaced.observedAt = "2026-07-28T20:00:01.000Z";
replaced.process.imageFileId = "abcd1234:0x00000000000000000000000000000002";
assert(
  validateReleaseSurfaceWindowsRuntimeContinuity(fixture, replaced)
    .some((error) => error.includes("binding changed")),
  "an executable replacement with the same path must not satisfy the native binding",
);
assert(
  validateReleaseSurfaceWindowsProbeOrder({
    attestedAt: "2026-07-28T20:00:00.000Z",
    beforeAt: "2026-07-28T20:00:02.000Z",
    afterAt: "2026-07-28T20:00:01.000Z",
  }).some((error) => error.includes("predates before-driver")),
  "Windows native evidence must preserve candidate-before-after order",
);
const wrongOwner = structuredClone(fixture);
wrongOwner.listener.owningPid = 9999;
assert(
  validateReleaseSurfaceWindowsNativeRuntime(wrongOwner, { processId: 4321, port: 30123 })
    .some((error) => error.includes("listener owner")),
  "a different socket-owning PID must be rejected",
);
const wrongOrchestrator = structuredClone(fixture);
wrongOrchestrator.orchestrator = "native";
assert(
  validateReleaseSurfaceWindowsNativeRuntime(wrongOrchestrator, {
    processId: 4321,
    port: 30123,
    orchestrator: "wsl",
  }).some((error) => error.includes("orchestrator")),
  "collector provenance must match the caller's runtime",
);
for (const malformedFileId of [
  "abcd:0x1",
  "abcd1234:0x1",
  "abcd1234:0x000000000000000000000000000000001",
  "abcd123g:0x00000000000000000000000000000001",
]) {
  const malformed = structuredClone(fixture);
  malformed.process.imageFileId = malformedFileId;
  assert(
    validateReleaseSurfaceWindowsNativeRuntime(malformed, { processId: 4321, port: 30123 })
      .some((error) => error.includes("imageFileId")),
    `malformed Windows file ID must be rejected: ${malformedFileId}`,
  );
}
const unicodePath = structuredClone(fixture);
unicodePath.process.imagePath = "C:\\Temp\\ShellX-ž-漢.exe";
assert.deepEqual(validateReleaseSurfaceWindowsNativeRuntime(unicodePath, {
  processId: 4321,
  port: 30123,
  imagePath: "c:/temp/shellx-ž-漢.exe",
}), []);

const collectorSource = readFileSync(resolve(import.meta.dirname, "collect-release-surface-windows-runtime.ps1"), "utf8");
assert(collectorSource.includes("Get-Process -Id $ProcessId"));
assert(collectorSource.includes("GetVolumeInformation"));
assert(collectorSource.includes("[Security.Cryptography.SHA256]::Create()"));
assert(!collectorSource.includes("Get-FileHash"));
assert(!collectorSource.includes("Get-CimInstance"));
const fixtureSource = readFileSync(
  resolve(import.meta.dirname, "fixtures", "release-surface-windows-runtime-server-fixture.ps1"),
  "utf8",
);
assert(fixtureSource.includes("Get-Process -Id $PID"));
assert(!fixtureSource.includes("Get-CimInstance"));

assert.equal(releaseSourceOnlyRequested(""), false);
assert.equal(releaseSourceOnlyRequested("1"), true);
assert.throws(() => releaseSourceOnlyRequested("0"), /must be exactly 1/);
const sourceOnly = releaseSourceOnlyRequested();
const powershell = sourceOnly ? null : resolvePowerShell();
if (sourceOnly) {
  console.log("SKIP Windows native runtime live fixture: source-only pre-push qualification requested");
}
else if (powershell) {
  assertPowerShellUtf8RoundTrip(powershell);
  await runLiveWindowsCollectorTest(powershell);
}
else console.log("Windows native runtime live fixture unavailable on this host; schema red tests passed");

console.log("Release surface Windows native runtime tests passed");

async function runLiveWindowsCollectorTest(powershellPath: string): Promise<void> {
  const windowsTemp = runPowerShell(powershellPath, "[IO.Path]::GetTempPath()").trim();
  const nodeTemp = process.platform === "win32" ? windowsTemp : mapPath("-u", windowsTemp);
  const temp = mkdtempSync(join(nodeTemp, "shellx-native-runtime-"));
  const stateNodePath = join(temp, "listener.json");
  const stateWindowsPath = process.platform === "win32" ? stateNodePath : mapPath("-w", stateNodePath);
  const tokenNodePath = join(temp, "shellxagent.token");
  const tokenWindowsPath = process.platform === "win32" ? tokenNodePath : mapPath("-w", tokenNodePath);
  writeFileSync(tokenNodePath, "fixture-runtime-token-that-is-long-enough", { encoding: "utf8", mode: 0o600 });
  const fixtureScriptNode = resolve(import.meta.dirname, "fixtures", "release-surface-windows-runtime-server-fixture.ps1");
  const fixtureScriptWindows = process.platform === "win32" ? fixtureScriptNode : mapPath("-w", fixtureScriptNode);
  let child: ChildProcess | null = null;
  let ownedPid: number | null = null;
  try {
    child = spawn(powershellPath, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fixtureScriptWindows,
      "-StatePath", stateWindowsPath,
      "-TokenPath", tokenWindowsPath,
      "-InstanceId", "fixture-instance-0001",
      "-Version", releaseSurfaceFixtureVersion,
      "-SourceCommit", "b".repeat(40),
      "-MaxLifetimeSeconds", "30",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const state = await waitForState(stateNodePath, child);
    ownedPid = state.pid;
    const first = collectReleaseSurfaceWindowsNativeRuntime({
      processId: state.pid,
      port: state.port,
      powershellPath,
    });
    assert.equal(first.process.pid, state.pid);
    assert.equal(first.orchestrator, process.platform === "win32" ? "native" : "wsl");
    assert.equal(first.listener.owningPid, state.pid);
    assert.equal(first.listener.port, state.port);
    assert.equal(normalizePath(first.process.imagePath), normalizePath(state.executablePath));
    const second = collectReleaseSurfaceWindowsNativeRuntime({
      processId: state.pid,
      port: state.port,
      powershellPath,
    });
    assert.equal(second.process.startId, first.process.startId, "stable process start identity must survive repeated probes");
    assert.equal(second.process.imageFileId, first.process.imageFileId, "stable executable file identity must survive repeated probes");
    const request = windowsRuntimeRequest(state, first, tokenWindowsPath);
    const restarted = structuredClone(request);
    restarted.runtime.windowsNative!.process.startId = "2026-07-28T00:00:00.000Z";
    await assert.rejects(
      probeReleaseSurfaceRuntimeCandidate(restarted, "after-driver"),
      /binding changed/,
      "the central Windows probe must reject a different process epoch while the exact candidate is still live",
    );
    const probe = await probeReleaseSurfaceRuntimeCandidate(request, "before-driver");
    assert.equal(probe.windowsNativeRuntime?.process.startId, first.process.startId);
    assert.equal(probe.health.processId, state.pid);
    const staleProbe = structuredClone(probe);
    staleProbe.windowsNativeRuntime!.observedAt = new Date(Date.parse(probe.observedAt) - 24 * 60 * 60_000).toISOString();
    assert(
      validateReleaseSurfaceRuntimeProbe(staleProbe, request, "before-driver")
        .some((error) => error.includes("stale")),
      "a replayed native observation must not satisfy a later runtime probe",
    );
  } finally {
    if (!ownedPid && existsSync(stateNodePath)) {
      const match = readFileSync(stateNodePath, "utf8").match(/"pid"\s*:\s*(\d+)/);
      if (match) ownedPid = Number(match[1]);
    }
    if (ownedPid) {
      runPowerShell(
        powershellPath,
        `if (Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${ownedPid} -Force }`,
      );
    }
    if (child && !(await waitForChildExit(child, 5_000))) {
      child.kill("SIGTERM");
      if (!(await waitForChildExit(child, 2_000))) {
        throw new Error("Windows listener fixture did not terminate; temporary evidence was preserved");
      }
    }
    rmSync(temp, { recursive: true });
  }
}

function windowsRuntimeRequest(
  state: { pid: number; port: number; executablePath: string },
  observation: ReleaseSurfaceWindowsNativeRuntime,
  tokenWindowsPath: string,
): ReleaseSurfaceDriverRequest {
  return {
    schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
    mode: "final-frozen-candidate",
    driverId: "fixture-installed",
    driverKind: "tauri-command",
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "e".repeat(64),
    artifact: { basename: "powershell.exe", sha256: observation.process.imageSha256 },
    controller: syntheticReleaseSurfaceControllerBinding("b".repeat(40)),
    runtime: {
      processId: state.pid,
      instanceId: "fixture-instance-0001",
      debugBase: `http://127.0.0.1:${state.port}`,
      debugTokenPath: tokenWindowsPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenWindowsPath,
      executableSha256: observation.process.imageSha256,
      installedPayloadPath: state.executablePath,
      installedManifestSha256: "e".repeat(64),
      windowsNative: toReleaseSurfaceWindowsNativeBinding(observation),
    },
    assignments: [{
      surface: {
        id: "tauri-command:fixture",
        kind: "tauri-command",
        name: "fixture",
        source: "fixture.rs",
        platforms: ["windows-installed"],
        delivery: "installed-app",
      },
      fixtureId: "fixture:isolated-profile",
      expectedEffect: "fixture effect",
      oracleId: "fixture:effect",
      cleanupId: "fixture:cleanup",
    }],
  };
}

function assertPowerShellUtf8RoundTrip(powershellPath: string): void {
  const expected = "C:\\Temp\\ShellX-ž-漢.exe";
  const stdout = runPowerShell(
    powershellPath,
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [pscustomobject]@{ imagePath = '${expected}' } | ConvertTo-Json -Compress`,
  );
  const parsed = JSON.parse(stdout) as { imagePath?: string };
  assert.equal(parsed.imagePath, expected, "PowerShell collector output must preserve Unicode paths as UTF-8");
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

function resolvePowerShell(): string | null {
  for (const candidate of process.platform === "win32" ? ["powershell.exe", "powershell"] : ["powershell.exe"]) {
    const result = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function runPowerShell(powershellPath: string, command: string): string {
  const result = spawnSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PowerShell failed").trim());
  return result.stdout.replaceAll("\r", "");
}

function mapPath(direction: "-u" | "-w", path: string): string {
  const result = spawnSync("wslpath", [direction, path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`wslpath ${direction} failed for ${path}`);
  return result.stdout.trim();
}

async function waitForState(path: string, child: ChildProcess): Promise<{ pid: number; port: number; executablePath: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as { pid?: number; port?: number; executablePath?: string };
      if (Number.isSafeInteger(parsed.pid) && Number.isSafeInteger(parsed.port) && parsed.executablePath?.trim()) {
        return { pid: Number(parsed.pid), port: Number(parsed.port), executablePath: parsed.executablePath };
      }
    }
    if (child.exitCode !== null) throw new Error(`Windows listener fixture exited early with ${child.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Windows listener fixture did not publish its state");
}

function normalizePath(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}
