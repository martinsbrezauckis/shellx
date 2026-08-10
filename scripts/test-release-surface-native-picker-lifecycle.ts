import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  executeNativePickerLifecycleDriver,
  prepareNativePickerFixture,
  removeNativePickerFixture,
} from "./release-drivers/native-picker-lifecycle";

const repo = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-native-picker-lifecycle-"));
const runId = "0123456789abcdef";
const profile = join(temp, `shellx-final-webdriver-${runId}`);
const tokenPath = join(profile, ".shellx", "shellxagent.token");
const statePath = join(temp, "fixture-state.json");
const token = "fixture-native-picker-token-0001";
const sessionId = "fixture-native-picker-session-0001";
const instanceId = "fixture-native-picker-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
let server: ChildProcess | null = null;

mkdirSync(join(profile, ".shellx"), { recursive: true });
writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
writeProfileMarker();

try {
  const fixtureRequest = baseRequest(tokenPath);
  const fixture = prepareNativePickerFixture(fixtureRequest, "keyboard-shortcut:attach");
  assert.equal(resolve(fixture.root), fixture.root);
  assert.equal(lstatSync(fixture.root).isDirectory(), true);
  assert.equal(lstatSync(fixture.directory).isDirectory(), true);
  assert.equal(lstatSync(fixture.file).isFile(), true);
  assert.equal(lstatSync(fixture.keyfile).isFile(), true);
  assert.equal(readFileSync(fixture.file, "utf8"), "ShellX final native picker fixture\n");
  assert.deepEqual(JSON.parse(readFileSync(fixture.keyfile, "utf8")), {
    schema: "shellx/vault-keyfile@1",
    fixture: "SHELLX_RELEASE_SYNTHETIC_KEYFILE_035",
  });
  assert.throws(
    () => prepareNativePickerFixture(fixtureRequest, "keyboard-shortcut:attach"),
    /must be absent before creation/,
  );
  removeNativePickerFixture(fixtureRequest, fixture);
  assert.equal(existsSync(fixture.root), false);

  const outside = join(temp, "release-native-picker-aaaaaaaaaaaaaaaa");
  mkdirSync(outside);
  assert.throws(
    () => removeNativePickerFixture(fixtureRequest, {
      root: outside,
      file: join(outside, "a"),
      directory: join(outside, "b"),
      keyfile: join(outside, "c"),
    }),
    /outside its exact receipt-owned root/,
  );
  rmSync(outside, { recursive: true });

  const markerPath = join(profile, "shellx-final-profile.json");
  const originalMarker = readFileSync(markerPath, "utf8");
  const driftedMarker = JSON.parse(originalMarker) as Record<string, unknown>;
  driftedMarker.launchPath = `${profile}-drifted`;
  writeFileSync(markerPath, `${JSON.stringify(driftedMarker, null, 2)}\n`, "utf8");
  assert.throws(
    () => prepareNativePickerFixture(fixtureRequest, "palette-action:act-attach"),
    /marker did not match/,
  );
  writeFileSync(markerPath, originalMarker, "utf8");

  const plan = JSON.parse(readFileSync(join(repo, "release", "surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const expectedDriverIds = [
    "keyboard-shortcut-native-picker-installed",
    "palette-action-native-picker-installed",
    "ui-control-native-picker-lifecycle-installed",
  ];
  for (const id of expectedDriverIds) {
    const driver = plan.drivers.find((candidate) => candidate.id === id);
    assert(driver, `missing native picker driver ${id}`);
    assert.deepEqual(driver.platforms, {
      "windows-installed": "ready",
      "macos-installed": "ready",
      "linux-installed": "ready",
    });
  }
  const planAssignments = plan.assignments.filter((assignment) => expectedDriverIds.includes(assignment.driverId));
  assert.equal(planAssignments.length, 9);
  assert(planAssignments.every((assignment) => !assignment.expectedEffect.startsWith("BUILDING:")));

  const driverSource = readFileSync(join(repo, "scripts", "release-drivers", "native-picker-lifecycle.ts"), "utf8");
  assert(!driverSource.includes("executeReleaseSurfaceInstalledInputScript"));
  assert(!driverSource.includes("shellx-host"));
  assert(!driverSource.includes("openDialog"));
  assert(driverSource.includes("isolated native-picker lease"));
  assert(driverSource.includes("renderer-bound native-picker result"));
  assert(driverSource.includes("input.transport === \"macos-native-input\" ? [\"meta\", \"u\"] : [\"\\uE009\", \"u\"]"));

  const dialogWrapperSource = readFileSync(join(repo, "src", "lib", "shellx-dialog.ts"), "utf8");
  assert(dialogWrapperSource.includes('invoke<ShellxReleasePickerClaim | null>("release_test_take_native_picker", { kind })'));
  assert(dialogWrapperSource.includes("if (!inTauri()) return null"));
  assert(dialogWrapperSource.includes("return await openDialog(options)"));
  for (const sourcePath of [
    "src/App.tsx",
    "src/browser/hooks/useBrowserPageActions.ts",
    "src/components/settings/GeneralTab.tsx",
  ]) {
    const source = readFileSync(join(repo, sourcePath), "utf8");
    assert(source.includes("openShellxDialog("), `${sourcePath} must traverse the production picker wrapper`);
    assert(!source.includes("open as openDialog"), `${sourcePath} must not bypass the production picker wrapper`);
  }
  const vaultSetupSource = readFileSync(join(repo, "src", "components", "settings", "VaultSetupPanel.tsx"), "utf8");
  assert(vaultSetupSource.includes('takeShellxReleasePickerClaim("file")'));
  assert(vaultSetupSource.includes("keyfileInputRef.current?.click()"));
  assert(vaultSetupSource.includes("claim.syntheticText.length > 16 * 1024"));

  await assert.rejects(
    executeNativePickerLifecycleDriver({ ...fixtureRequest, assignments: [] }),
    /requires the exact platform-native macOS helper or Windows\/Linux native WebDriver binding/,
  );

  server = spawn(process.execPath, [
    "--import", "tsx", resolve(repo, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--profile-root", profile,
  ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, server);
  const request = installedRequest(
    tokenPath,
    `http://127.0.0.1:${ports.candidatePort}`,
    `http://127.0.0.1:${ports.webdriverPort}`,
    ports.candidatePort,
    planAssignments,
  );
  const report = await executeNativePickerLifecycleDriver(request);
  assert.equal(report.outcomes.length, 9);
  assert(report.outcomes.every((outcome) => outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error), JSON.stringify(report.outcomes, null, 2));
  assert(report.outcomes.every((outcome) => outcome.observedEffect.includes("isolated one-shot")
    || outcome.id.endsWith('#18') && outcome.observedEffect.includes("native click")));

  const audit = await getJson<{
    settingsOpen?: boolean;
    bottomPanelAttachmentPaths?: string[];
    activeTab?: { cwd?: string };
    vaultKeyfileSelected?: boolean;
    releaseNativePickerArmed?: boolean;
    currentWindow?: string;
    browserWindowOpen?: boolean;
  }>(`http://127.0.0.1:${ports.candidatePort}/audit`, token);
  assert.equal(audit.settingsOpen, false);
  assert.deepEqual(audit.bottomPanelAttachmentPaths, []);
  assert.equal(audit.activeTab?.cwd, "/fixture/original-cwd");
  assert.equal(audit.vaultKeyfileSelected, false);
  assert.equal(audit.releaseNativePickerArmed, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.browserWindowOpen, false);
  assert.deepEqual(readdirSync(profile).filter((name) => name.startsWith("release-native-picker-")), []);

  console.log(`Release surface native picker lifecycle tests passed (9 ${fixturePlatform} native-WebDriver contracts; all-platform bindings ready; macOS retains real OS-dialog selection)`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  if (server) await waitForExit(server);
  rmSync(temp, { recursive: true, force: true });
}

function writeProfileMarker(): void {
  writeFileSync(join(profile, "shellx-final-profile.json"), `${JSON.stringify({
    schema: "shellx/release-surface-run-profile@1",
    platform: fixturePlatform,
    runId,
    nodePath: profile,
    launchPath: profile,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function baseRequest(debugTokenPath: string): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-native-picker-lifecycle-installed",
    driverKind: "ui-control",
    platform: fixturePlatform,
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "b".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: "http://127.0.0.1:31001",
      debugTokenPath,
      mcpBase: "http://127.0.0.1:31002",
      mcpTokenPath: join(profile, ".shellx", "mcp.token"),
      executableSha256: "d".repeat(64),
      installedPayloadPath: fixtureImagePath,
      installedManifestSha256: "e".repeat(64),
    },
    assignments: [],
  };
}

function installedRequest(
  debugTokenPath: string,
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
  planAssignments: FinalSurfaceDriverPlan["assignments"],
): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(repo, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  return {
    ...baseRequest(debugTokenPath),
    inventoryDigest: inventory.digest,
    runtime: {
      ...baseRequest(debugTokenPath).runtime,
      debugBase: candidateBase,
      ...(fixturePlatform === "windows-installed" ? {
        windowsNative: {
          schema: "shellx/release-surface-windows-native-binding@1" as const,
          process: {
            pid: 4321,
            startId: "2026-07-28T17:59:00.000Z",
            imagePath: fixtureImagePath,
            imageSha256: "d".repeat(64),
            imageBytes: 1024,
            imageFileId: `abcd1234:0x${"1".repeat(32)}`,
          },
          listener: { address: "127.0.0.1" as const, port: candidatePort, owningPid: 4321 },
        },
      } : {
        posixNative: releaseSurfacePosixNativeBindingFixture({
          processId: 4321,
          port: candidatePort,
          imagePath: fixtureImagePath,
          imageSha256: "d".repeat(64),
        }),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1_024 },
    },
    assignments: planAssignments.map((assignment) => {
      const surface = surfaceById.get(assignment.surfaceId);
      assert(surface, `missing native picker surface ${assignment.surfaceId}`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    }),
  };
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`native picker fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("native picker fixture did not publish its ports");
}

async function getJson<T>(url: string, authToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.json() as T;
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
