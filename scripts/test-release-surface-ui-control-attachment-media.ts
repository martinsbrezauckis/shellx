import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
  releaseSurfaceFixtureVersion,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-attachment-media-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-attachment-media-token-0001";
const sessionId = "fixture-ui-attachment-media-session-0001";
const instanceId = "fixture-ui-attachment-media-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const fixtureId = "ui:attachment-media-owned-lifecycle";
const blockedSurfaceIds: string[] = [];
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-bounded-installed" && assignment.fixtureId === fixtureId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Attachment/Media assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 16);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 16);

  const blocked = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.surfaceId.includes("src/components/AttachmentMediaBoard.tsx")
  ));
  assert.deepEqual(blocked.map((assignment) => assignment.surfaceId).sort(), blockedSurfaceIds);
  assert(blocked.every((assignment) => (
    assignment.fixtureId === "ui:attachment-media-excluded-native-or-prompt-path"
    && assignment.expectedEffect.startsWith("BUILDING:")
    && assignment.oracleId.endsWith(":building-blocker")
    && assignment.cleanupId === "ui:not-invoked"
  )));
  const nativeAttach = plan.assignments.find((assignment) => (
    assignment.surfaceId
      === 'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach file"]@src/components/AttachmentMediaBoard.tsx#4'
  ));
  assert.equal(nativeAttach?.driverId, "ui-control-native-picker-lifecycle-installed");
  assert.equal(nativeAttach?.oracleId, "ui:activation:native-picker-exact-owned-file-attached");

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
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert(manifest.supportedFixtures.includes(fixtureId));
  assert(manifest.supportedCleanups.includes("ui:clear-owned-attachment-media-and-delete-root"));
  for (const oracle of [
    "ui:activation:owned-attachment-preview",
    "ui:activation:owned-attachment-removed",
    "ui:activation:owned-asset-imported",
    "ui:activation:owned-asset-attached",
    "ui:activation:owned-attachment-prompt-inserted",
    "ui:boolean-state-transition",
  ]) assert(manifest.supportedOracles.includes(oracle), `manifest is missing ${oracle}`);

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bounded-installed",
    driverKind: "ui-control",
    platform: fixturePlatform,
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-bounded-installed.ts", [
      "scripts/release-drivers/ui-control-installed.ts",
      "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
      ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
    ]),
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
          listener: {
            address: "127.0.0.1" as const,
            port: Number(new URL(candidateBase).port),
            owningPid: 4321,
          },
        },
      } : {
        posixNative: releaseSurfacePosixNativeBindingFixture({
          processId: 4321,
          port: Number(new URL(candidateBase).port),
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
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 240_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 16);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.startsWith("Native WebDriver installed input")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    bottomTab: string;
    rightTab: string;
    activeTab: Record<string, unknown>;
    ownedModalOpen: string | null;
    previewTarget: Record<string, unknown> | null;
    previewVideoPlaybackState: string;
    attachmentMediaPendingPaths: string[];
    attachmentMediaSessionPath: string | null;
    attachmentMediaImagePath: string | null;
    attachmentMediaVideoPath: string | null;
    bottomPanelComposerPrompt: string;
    clickedSelectors: string[];
  };
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.cwd, "/fixture/original-cwd");
  assert.equal(audit.ownedModalOpen, null);
  assert.equal(audit.previewTarget, null);
  assert.equal(audit.previewVideoPlaybackState, "idle");
  assert.deepEqual(audit.attachmentMediaPendingPaths, []);
  assert.equal(audit.attachmentMediaSessionPath, null);
  assert.equal(audit.attachmentMediaImagePath, null);
  assert.equal(audit.attachmentMediaVideoPath, null);
  assert.equal(audit.bottomPanelComposerPrompt, "");
  assert(audit.clickedSelectors.some((selector) => selector.endsWith("button:nth-child(3)")));
  assert(audit.clickedSelectors.some((selector) => selector.endsWith("button:nth-child(4)")));
  assert(audit.clickedSelectors.some((selector) => selector.endsWith("button:nth-child(5)")));
  assert(audit.clickedSelectors.some((selector) => selector.endsWith(".composer-attachment-action:nth-of-type(3)")));
  assert.equal(
    audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='surface-components-mediapreview-1']").length,
    2,
  );
  assert(!audit.clickedSelectors.some((selector) => (
    selector.includes("Attach file")
    || selector.includes("Attach app screenshot")
  )), "focused lifecycle must not invoke pickers or screenshot capture");
  assert.equal(existsSync(join(profileRoot, "ui-attachment-media-lifecycle")), false);

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "Attachment/Media evidence output must remain create-only");
  console.log("Attachment/Media native WebDriver lifecycle passed: 16 deterministic controls including app-owned video play/pause, 1 all-platform native-picker contract, 0 explicit BUILDING blockers");
} finally {
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
      throw new Error(`Attachment/Media fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Attachment/Media fixture did not publish its ports");
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
