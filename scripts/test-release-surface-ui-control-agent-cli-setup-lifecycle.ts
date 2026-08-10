import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import { exerciseAgentCliSetupLifecycleControl } from "./release-drivers/ui-control-agent-cli-setup-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-agent-cli-setup-"));
const profileRoot = join(temp, `shellx-final-webdriver-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-agent-cli-setup-token-0001";
const sessionId = "fixture-agent-cli-setup-session-0001";
const instanceId = "fixture-agent-cli-setup-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const entrypoint = "scripts/release-drivers/ui-control-agent-cli-setup-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-agent-cli-setup-lifecycle.ts",
];
const nativeSource = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");
const externalCommandStart = nativeSource.indexOf("async fn open_url_in_browser(");
const isolatedExternalGate = nativeSource.indexOf("if crate::isolated_test_instance_requested()", externalCommandStart);
const isolatedExternalReceipt = nativeSource.indexOf('hub.record_raw_event("external-url-dispatched"', isolatedExternalGate);
const isolatedExternalReturn = nativeSource.indexOf("return Ok(());", isolatedExternalReceipt);
const nativeExternalLaunch = nativeSource.indexOf('std::process::Command::new("rundll32")', isolatedExternalReturn);
assert(
  externalCommandStart >= 0
    && isolatedExternalGate > externalCommandStart
    && isolatedExternalReceipt > isolatedExternalGate
    && isolatedExternalReturn > isolatedExternalReceipt
    && nativeExternalLaunch > isolatedExternalReturn,
  "isolated release fixtures must record the exact external URL and return before any OS browser process can launch",
);

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
    "--version", releaseSurfaceFixtureVersion,
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
  assert.equal(manifest.id, "ui-control-agent-cli-setup-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, [
    "ui:agent-cli-setup-owned-dialog-open",
    "ui:agent-cli-status-owned-setup-open",
    "ui:agent-cli-owned-target-live-refresh",
    "ui:agent-cli-owned-npm-install-lifecycle",
    "ui:agent-cli-owned-doc-link-cards",
    "ui:agent-cli-owned-doc-link-confirmation",
  ]);
  assert.deepEqual(manifest.supportedCleanups, [
    "ui:close-agent-cli-setup-owned-dialog",
    "ui:close-agent-cli-status-dialog-and-restore-right-rail",
    "ui:close-agent-cli-live-scan-delete-owned-binary-restore-right-rail",
    "ui:cancel-agent-cli-preparation-close-dialog-delete-owned-shim-and-receipt",
  ]);
  assert.deepEqual(manifest.supportedOracles, [
    "ui:activation:agent-cli-setup-dialog-closed",
    "ui:activation:agent-cli-status-setup-dialog-opened",
    "ui:activation:agent-cli-fresh-version-observed",
    "ui:activation:agent-cli-owned-npm-confirmation-prepared",
    "ui:activation:agent-cli-owned-npm-confirmation-cancelled",
    "ui:activation:agent-cli-owned-npm-shim-receipt",
    "ui:activation:agent-cli-doc-link-dispatched",
  ]);
  assert.deepEqual(manifest.controllerFiles, controllerFiles);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseAgentCliSetupLifecycleControl({ base: candidateBase, token }, input, assignment, request));
  }
  assert.equal(outcomes.length, 14);
  assert(outcomes.every((outcome) => outcome.present === "pass"));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"));
  assert(outcomes.every((outcome) => outcome.effect === "pass"));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"));

  const finalState = await getJson<{
    agentCliSetupFixture?: string;
    agentCliStatusDialogProvider?: string | null;
    rightTab?: string;
  }>(`${candidateBase}/state/ui`, token);
  assert.equal(finalState.agentCliSetupFixture, "closed");
  assert.equal(finalState.agentCliStatusDialogProvider, null);
  assert.equal(finalState.rightTab, "Tasks");
  const audit = await getJson<{
    clickedSelectors?: string[];
    ownedAgentCliVersion?: string | null;
    ownedAgentCliScanCount?: number;
    agentCliInstallConfirmationId?: string | null;
    agentCliInstallPrepareCount?: number;
    agentCliInstallCancelCount?: number;
    agentCliInstallRunCount?: number;
    aboutExternalUrls?: string[];
  }>(`${candidateBase}/audit`, token);
  for (const selector of [
    "[data-debug-id='agent-cli-setup-open-grok']",
    "[data-debug-id='agent-cli-setup-open-claude-code']",
    "[data-debug-id='agent-cli-setup-open-codex-cli']",
    "[data-debug-id='agent-cli-setup-open-antigravity-cli']",
    "[data-debug-id='agent-cli-setup-open-missing']",
  ]) {
    assert(audit.clickedSelectors?.includes(selector), `native installed input did not click ${selector}`);
  }
  assert(audit.clickedSelectors?.includes(".provider-runner-actions button:last-child"));
  assert(audit.clickedSelectors?.includes("[data-debug-id='agent-cli-setup-assistant'] .agent-cli-setup-header-actions button:first-child"));
  assert(audit.clickedSelectors?.includes("[data-debug-id='surface-components-agentclisetupassistant-5']"));
  assert(audit.clickedSelectors?.includes(".agent-cli-setup-confirm-actions button:first-child"));
  assert(audit.clickedSelectors?.includes("[data-debug-id='surface-components-agentclisetupassistant-9']"));
  assert(audit.clickedSelectors?.includes(".agent-cli-setup-card[data-agent-cli-provider='grok'] .agent-cli-setup-card-actions button:first-child"));
  assert(audit.clickedSelectors?.includes(".agent-cli-setup-confirm-links button:first-child"));
  assert.equal(audit.ownedAgentCliVersion, "shellx-refresh-2.0.0");
  assert.equal(audit.ownedAgentCliScanCount, 4);
  assert.equal(audit.agentCliInstallConfirmationId, null);
  assert.equal(audit.agentCliInstallPrepareCount, 3);
  assert.equal(audit.agentCliInstallCancelCount, 2);
  assert.equal(audit.agentCliInstallRunCount, 1);
  assert.deepEqual(audit.aboutExternalUrls, [
    "https://example.invalid/shellx-agent-cli-setup",
    "https://example.invalid/shellx-agent-cli-setup",
  ]);
  console.log("Release surface Agent CLI setup lifecycle tests passed (14 controls)");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
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
    .filter((assignment) => assignment.driverId === "ui-control-agent-cli-setup-lifecycle-installed")
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  assert.equal(assignments.length, 14);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-agent-cli-setup-lifecycle-installed",
    driverKind: "ui-control",
    platform: fixturePlatform,
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
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
      installedPayloadPath: fixtureImagePath,
      installedManifestSha256: "e".repeat(64),
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
      throw new Error(`Agent CLI setup fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Agent CLI setup fixture did not publish its ports");
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
