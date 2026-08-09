import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import {
  exerciseChatOutputJumpDebugSurface,
  exerciseChatOutputLifecycle,
} from "./release-drivers/ui-control-chat-output-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-chat-output-lifecycle-"));
const profileRoot = join(temp, `shellx-final-chat-output-${"d".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-chat-output-lifecycle-token-0001";
const sessionId = "fixture-chat-output-lifecycle-session-0001";
const instanceId = "fixture-chat-output-lifecycle-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-chat-output-lifecycle-installed.ts";
const jumpEntrypoint = "scripts/release-drivers/ui-debug-chat-output-jump-lifecycle-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "src/lib/debug-renderer-fixture.ts",
  "scripts/release-drivers/ui-control-chat-output-lifecycle.ts",
];
const exactSelectors = new Set([
  "[data-debug-id=\"surface-components-chatoutput-1\"]",
  "[data-debug-id=\"surface-components-chatoutput-3\"]",
  "[data-debug-id=\"surface-components-chatoutput-4\"]",
  "[data-debug-id=\"surface-components-chatoutput-5\"]",
  "[aria-label^=\"Dismiss warning: \"]",
  "[aria-label=\"Dismiss host MCP unreachable warning\"]",
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
  assert.equal(manifest.id, "ui-control-chat-output-lifecycle-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  assert.deepEqual(manifest.supportedFixtures, ["ui:chat-output-owned-renderer-lifecycle"]);
  assert.deepEqual(manifest.supportedCleanups, ["ui:clear-owned-chat-output-events-close-preview-delete-files-and-restore-view"]);
  assert.equal(manifest.supportedOracles.length, 6);

  const jumpDescribed = spawnSync(process.execPath, ["--import", "tsx", resolve(root, jumpEntrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(jumpDescribed.status, 0, jumpDescribed.stderr || jumpDescribed.stdout);
  const jumpManifest = JSON.parse(jumpDescribed.stdout) as {
    id: string;
    kind: string;
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(jumpManifest.id, "ui-debug-chat-output-jump-lifecycle-installed");
  assert.equal(jumpManifest.kind, "ui-debug-surface");
  assert.equal(jumpManifest.invocationTransport, "native-installed-input");
  assert.deepEqual(jumpManifest.controllerFiles, controllerFiles);
  assert.deepEqual(jumpManifest.supportedFixtures, ["ui:chat-output-owned-native-scroll-marker"]);
  assert.deepEqual(jumpManifest.supportedCleanups, ["ui:clear-owned-chat-output-scroll-marker-and-restore-view"]);
  assert.deepEqual(jumpManifest.supportedOracles, ["ui:visible-native-scroll-marker-rectangle"]);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = await exerciseChatOutputLifecycle(
    { base: candidateBase, token },
    installedInput,
    request,
    request.assignments,
  );
  assert.equal(outcomes.length, 6);
  assert(outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  )), JSON.stringify(outcomes, null, 2));
  assert.equal(existsSync(join(profileRoot, "ui-chat-output-preview-lifecycle")), false);

  const jumpRequest = createRequest(
    candidateBase,
    webdriverBase,
    ports.candidatePort,
    "ui-debug-chat-output-jump-lifecycle-installed",
    "ui-debug-surface",
  );
  const jumpOutcome = await exerciseChatOutputJumpDebugSurface(
    { base: candidateBase, token },
    createReleaseSurfaceInstalledInputSession(jumpRequest, { base: candidateBase, token }),
    jumpRequest.assignments[0]!,
  );
  assert.deepEqual(
    [jumpOutcome.present, jumpOutcome.invoke, jumpOutcome.effect, jumpOutcome.cleanup, jumpOutcome.error],
    ["pass", "pass", "pass", "pass", undefined],
  );

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    bottomTab: string;
    activeTab: { tabId?: string };
    chatOutputLifecycleActive: boolean;
    chatOutputThoughtExpanded: boolean;
    chatOutputJumpVisible: boolean;
    chatOutputDoomVisible: boolean;
    chatOutputHostVisible: boolean;
    chatOutputUpCount: number;
    chatOutputAttachmentPath: string | null;
    chatOutputDiffPath: string | null;
    previewFilePath: string | null;
    clickedSelectors: string[];
  };
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.chatOutputLifecycleActive, false);
  assert.equal(audit.chatOutputThoughtExpanded, false);
  assert.equal(audit.chatOutputJumpVisible, false);
  assert.equal(audit.chatOutputDoomVisible, false);
  assert.equal(audit.chatOutputHostVisible, false);
  assert.equal(audit.chatOutputUpCount, 0);
  assert.equal(audit.chatOutputAttachmentPath, null);
  assert.equal(audit.chatOutputDiffPath, null);
  assert.equal(audit.previewFilePath, null);
  assert(audit.clickedSelectors.includes(".output"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-chatoutput-1']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-chatoutput-3']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-chatoutput-4']"));
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='surface-components-chatoutput-5']").length, 2);
  assert(audit.clickedSelectors.includes("[aria-label^='Dismiss warning: ']"));
  assert(audit.clickedSelectors.includes("[aria-label='Dismiss host MCP unreachable warning']"));

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const excluded = plan.assignments.filter((assignment) => (
    assignment.surfaceId.includes("src/components/ChatOutput.tsx")
    && assignment.driverId.endsWith("-backlog-installed")
  ));
  assert.equal(excluded.length, 0);
  assert(excluded.every((assignment) => (
    assignment.fixtureId === "ui:chat-output-excluded-clipboard-state"
    && assignment.expectedEffect.startsWith("BUILDING: ")
    && assignment.cleanupId === "ui:not-invoked"
  )));

  const chatOutputSource = readFileSync(join(root, "src/components/ChatOutput.tsx"), "utf8");
  const groupingSource = readFileSync(join(root, "src/lib/grouping.ts"), "utf8");
  const continuitySource = readFileSync(join(root, "src/lib/session-continuity.ts"), "utf8");
  assert(!chatOutputSource.includes("VendorPill") && !chatOutputSource.includes("surface-components-chatoutput-8"));
  assert(!groupingSource.includes("VendorGroup") && !groupingSource.includes('kind: "vendor"'));
  assert(!continuitySource.includes('case "vendor"'));

  console.log("Release surface ChatOutput lifecycle passed: 6 reversible controls, 1 native-scroll debug marker, 1 owned clipboard control, 0 BUILDING exclusions, and dead VendorPill removed");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
  driverId = "ui-control-chat-output-lifecycle-installed",
  driverKind: "ui-control" | "ui-debug-surface" = "ui-control",
): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === driverId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `ChatOutput assignment ${assignment.surfaceId} must exist in the exact inventory`);
      assert(
        driverKind === "ui-debug-surface"
          ? surface.selector === "[data-debug-id=\"surface-components-chatoutput-1\"]"
          : exactSelectors.has(surface.selector ?? ""),
        `unexpected ChatOutput selector ${surface.selector}`,
      );
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  const expectedAssignmentCount = driverKind === "ui-debug-surface" ? 1 : 6;
  assert.equal(assignments.length, expectedAssignmentCount);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, expectedAssignmentCount);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind,
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "d".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "e".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "f".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "e".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "a".repeat(64), bytes: 1024 },
    },
    assignments,
  };
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`ChatOutput fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("ChatOutput fixture did not publish its ports");
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
