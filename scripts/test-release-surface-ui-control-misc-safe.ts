import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  exerciseMiscSafeUiControl,
  supportsMiscSafeUiControl,
} from "./release-drivers/ui-control-misc-safe";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-misc-safe-"));
const profileRoot = join(temp, `shellx-final-misc-safe-${"m".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-misc-safe-token-0001";
const sessionId = "fixture-ui-misc-safe-session-0001";
const instanceId = "fixture-ui-misc-safe-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const expectedOracles = new Set([
  "ui:boolean-state-transition",
  "ui:activation:hash-autocomplete-owned-insertion",
  "ui:activation:markdown-owned-file-preview-opened",
  "ui:activation:markdown-owned-external-handoff",
  "ui:activation:update-release-notes-external-handoff",
  "ui:activation:update-check-completed",
  "ui:activation:update-install-boundary-completed",
  "ui:activation:debug-api-websocket-reconnected",
  "ui:activation:error-boundary-renderer-recovered",
  "ui:activation:pr-create-remote-boundary",
  "ui:activation:artifact-archive-save-picker-boundary",
]);
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
  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  assert.equal(request.assignments.length, 16);
  assert(request.assignments.every(supportsMiscSafeUiControl));
  assert.deepEqual(new Set(request.assignments.map((assignment) => assignment.oracleId)), expectedOracles);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  for (const assignment of request.assignments) {
    const outcome = await exerciseMiscSafeUiControl(
      { base: candidateBase, token },
      input,
      request,
      assignment,
    );
    assert.deepEqual(
      [outcome.present, outcome.invoke, outcome.effect, outcome.cleanup],
      ["pass", "pass", "pass", "pass"],
      JSON.stringify(outcome, null, 2),
    );
    assert.match(outcome.observedEffect, /native webdriver/i);
  }

  const audit = await getJson<{
    ownedModalOpen?: unknown;
    previewTarget?: unknown;
    prTranscriptActive?: unknown;
    hashItemsFixtureActive?: unknown;
    alwaysVisibleTextValues?: Record<string, unknown>;
    aboutExternalUrls?: string[];
    debugUpdateFixture?: string;
    updateBannerAvailable?: boolean;
    rightRailUpdateAvailable?: boolean;
    aboutUpdateAvailable?: boolean;
    updateBannerReceipt?: string | null;
    rightRailUpdateReceipt?: string | null;
    aboutUpdateReceipt?: string | null;
    settingsOpen?: boolean;
    settingsTab?: string;
    debugUiConnectionFixture?: string;
    debugUiWebSocketActive?: number;
    debugUiWebSocketGeneration?: number;
    errorBoundaryOpen?: boolean;
    errorBoundaryDocumentGeneration?: number;
    rendererCrashEventCount?: number;
    releaseTestExternalEffectBoundary?: string | null;
    prCreateBoundaryReceipt?: string | null;
    artifactArchiveReceipt?: string | null;
    prApprovalChecked?: boolean;
    prTextValues?: Record<string, string>;
  }>(`${candidateBase}/audit`, token);
  assert.equal(audit.ownedModalOpen, null);
  assert.equal(audit.previewTarget, null);
  assert.equal(audit.prTranscriptActive, false);
  assert.equal(audit.hashItemsFixtureActive, false);
  assert.equal(audit.alwaysVisibleTextValues?.["[data-debug-id='composer-prompt']"], "");
  assert.deepEqual([...(audit.aboutExternalUrls ?? [])].sort(), [
    "https://example.invalid/shellx/release-docs",
    "https://github.com/martinsbrezauckis/shellx/releases/tag/v0.3.5-release-fixture",
    "https://github.com/martinsbrezauckis/shellx/releases/tag/v0.3.5-release-fixture",
  ].sort());
  assert.equal(audit.debugUpdateFixture, "owned-cleared");
  assert.deepEqual([
    audit.updateBannerAvailable,
    audit.rightRailUpdateAvailable,
    audit.aboutUpdateAvailable,
  ], [false, false, false]);
  assert.deepEqual([
    audit.updateBannerReceipt,
    audit.rightRailUpdateReceipt,
    audit.aboutUpdateReceipt,
  ], [null, null, null]);
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.settingsTab, "general");
  assert.equal(audit.debugUiConnectionFixture, "clear");
  assert.equal(audit.debugUiWebSocketActive, 1);
  assert.equal(audit.debugUiWebSocketGeneration, 4);
  assert.equal(audit.errorBoundaryOpen, false);
  assert.equal(audit.errorBoundaryDocumentGeneration, 2);
  assert.equal(audit.rendererCrashEventCount, 2);
  assert.equal(audit.releaseTestExternalEffectBoundary, null);
  assert.equal(audit.prCreateBoundaryReceipt, null);
  assert.equal(audit.artifactArchiveReceipt, null);
  assert.equal(audit.prApprovalChecked, false);
  assert.deepEqual(audit.prTextValues, {
    "[data-debug-id='pr-base-input']": "",
    "[data-debug-id='pr-title-input']": "",
    "[data-debug-id='pr-body-input']": "",
  });
  assert.equal(existsSync(join(profileRoot, "ui-misc-markdown-preview")), false);

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as {
    assignments: Array<{ driverId: string; fixtureId: string; expectedEffect: string; cleanupId: string }>;
  };
  const miscBlockers = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.fixtureId === "ui:misc-excluded-clipboard-url-provider-updater-git-session-or-destructive-state"
  ));
  assert.equal(miscBlockers.length, 0);
  assert(miscBlockers.every((assignment) => assignment.expectedEffect.startsWith("BUILDING:") && assignment.cleanupId === "ui:not-invoked"));
  console.log("Release surface miscellaneous UI lifecycle tests passed (16 reversible native lifecycles including 5 updater actions and 2 external-effect boundaries; 0 miscellaneous blockers)");
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
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
    ))
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }))
    .filter(supportsMiscSafeUiControl);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
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
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1_024 },
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
      throw new Error(`miscellaneous UI fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("miscellaneous UI fixture did not publish its ports");
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
