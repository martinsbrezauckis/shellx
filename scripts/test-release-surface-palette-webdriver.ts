import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-palette-webdriver-"));
const statePath = join(temp, "fixture-state.json");
const runId = "0123456789abcdef";
const profileRoot = join(temp, `shellx-final-webdriver-${runId}`);
const tokenPath = join(profileRoot, ".shellx", "shellxagent.token");
const screenshotDir = join(profileRoot, ".grok", "shellx-screenshots");
const baselineScreenshotPath = join(screenshotDir, "shellx-screenshot-1710000000000.png");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const screenshotRequestPath = join(temp, "screenshot-request.json");
const screenshotReportPath = join(temp, "screenshot-report.json");
const token = "fixture-palette-native-webdriver-token-0001";
const sessionId = "fixture-palette-session-0001";
const instanceId = "fixture-palette-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const actionIds = [
  "act-settings",
  "act-help",
  "act-asset-board",
  "act-pr",
  "act-vault",
  "act-open-work-preview",
  "act-desktop-integrations",
  "act-toggle-term",
  "act-new",
  "act-close",
  "act-auto-auto",
  "act-attach-screenshot",
  "act-connect",
  "act-abort",
];
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
  mkdirSync(join(profileRoot, ".shellx"), { recursive: true, mode: 0o700 });
  writeFileSync(join(profileRoot, "shellx-final-profile.json"), `${JSON.stringify({
    schema: "shellx/release-surface-run-profile@1",
    platform: fixturePlatform,
    runId,
    nodePath: profileRoot,
    launchPath: profileRoot,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    baselineScreenshotPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    { mode: 0o600 },
  );
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-palette-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
    "--screenshot-dir", screenshotDir,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;
  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "palette-action-installed",
    driverKind: "palette-action",
    platform: fixturePlatform,
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/palette-action-installed.ts", [
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
      "scripts/lib/release-surface-run-profile.ts",
      "scripts/release-drivers/owned-screenshot-attachment.ts",
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
    assignments: actionIds.map((id) => ({
      surface: {
        id: `palette-action:${id}`,
        kind: "palette-action",
        name: id,
        source: "src/App.tsx",
        platforms: ["linux-installed", "windows-installed", "macos-installed"],
        delivery: "installed-app",
      },
      fixtureId: id === "act-attach-screenshot"
        ? "palette:isolated-run-profile-with-empty-composer"
        : id === "act-connect" || id === "act-abort"
          ? "palette:isolated-local-grok-session"
        : "palette:app-shell-visible",
      expectedEffect: `${id} opens its exact visible effect`,
      oracleId: id === "act-toggle-term"
        ? "palette:act-toggle-term:state-transition"
        : id === "act-new"
          ? "palette:act-new:session-created"
          : id === "act-close"
            ? "palette:act-close:session-closed"
            : id === "act-auto-auto"
              ? `palette:${id}:autonomy-changed`
              : id === "act-attach-screenshot"
                ? "palette:act-attach-screenshot:owned-screenshot-attached"
                : id === "act-connect"
                  ? "palette:act-connect:owned-grok-session-active"
                  : id === "act-abort"
                    ? "palette:act-abort:owned-grok-session-aborted"
                : `palette:${id}:visible-effect`,
      cleanupId: id === "act-attach-screenshot"
        ? "palette:remove-chip-and-delete-exact-owned-screenshot"
        : id === "act-connect" || id === "act-abort"
          ? "palette:abort-owned-grok-session-and-restore-tab"
        : "palette:close-modal-and-clear-highlights",
    })),
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/palette-action-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  assert.equal(JSON.parse(described.stdout).invocationTransport, "native-installed-input");

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/palette-action-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(report.nativeWebDriver, request.nativeWebDriver);
  assert.equal(report.outcomes.length, actionIds.length);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("native installed-input click")
  )));

  const audit = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as {
    nativeClicks: string[];
    chords: string[][];
    releaseCount: number;
    paletteOpen: boolean;
    activeEffect: string | null;
    bottomTab: string;
    autonomy: string;
    activeTabId: string;
    openTabs: Array<{ tabId: string }>;
    attachmentActive: boolean;
    attachmentRemoveClicks: number;
    screenshotFileExists: boolean;
    providerActive: boolean;
    activeTab: Record<string, unknown>;
  };
  assert.deepEqual(auditBody.nativeClicks, actionIds, "every assigned action must receive one native WebDriver click");
  assert.equal(auditBody.paletteOpen, false);
  assert.equal(auditBody.activeEffect, null);
  assert.equal(auditBody.bottomTab, "Chat");
  assert.equal(auditBody.autonomy, "bypassPermissions");
  assert.equal(auditBody.activeTabId, "fixture-tab-1");
  assert.deepEqual(auditBody.openTabs, [{ tabId: "fixture-tab-1" }]);
  assert.equal(auditBody.attachmentActive, false);
  assert.equal(auditBody.attachmentRemoveClicks, 1);
  assert.equal(auditBody.screenshotFileExists, false);
  assert.equal(auditBody.providerActive, false);
  assert.deepEqual(auditBody.activeTab, {
    tabId: "fixture-tab-1",
    cwd: "/fixture/project",
    agentId: "grok",
    status: "Idle",
    isSending: false,
    connectionId: null,
    connectionLabel: "Local",
    connectionTransport: "local",
    autonomy: "bypassPermissions",
  });
  assert.equal(existsSync(baselineScreenshotPath), true, "exact cleanup must preserve a pre-existing screenshot baseline");
  assert.equal(auditBody.chords.length, 2, "session setup and cleanup use only the two bounded native tab chords");
  assert.equal(auditBody.releaseCount, 2, "every native setup or cleanup chord must release held keys");

  const screenshotRequest: ReleaseSurfaceDriverRequest = {
    ...request,
    driverId: "ui-control-screenshot-attachment-installed",
    driverKind: "ui-control",
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/ui-control-screenshot-attachment-installed.ts",
      [
        "scripts/lib/release-surface-installed-input-client.ts",
        "scripts/lib/release-surface-bounded-observation.ts",
        "scripts/lib/release-surface-macos-native-input.ts",
        "scripts/release-drivers/owned-screenshot-attachment.ts",
      ],
    ),
    assignments: [
      {
        surface: {
          id: 'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach app screenshot"]@src/components/AttachmentMediaBoard.tsx#5',
          kind: "ui-control",
          name: 'src/components/AttachmentMediaBoard.tsx:[title="Attach app screenshot"]',
          source: "src/components/AttachmentMediaBoard.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"],
          delivery: "installed-app",
        },
        fixtureId: "ui:isolated-profile-empty-composer-screenshot",
        expectedEffect: "asset board screenshot attaches an owned PNG",
        oracleId: "ui:activation:owned-app-screenshot-attached",
        cleanupId: "ui:remove-exact-screenshot-attachment-delete-owned-png-restore-view",
      },
      {
        surface: {
          id: 'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-screenshot"]@src/components/BottomPanel.tsx#16',
          kind: "ui-control",
          name: 'src/components/BottomPanel.tsx:[data-debug-id="composer-screenshot"]',
          source: "src/components/BottomPanel.tsx",
          platforms: ["linux-installed", "windows-installed", "macos-installed"],
          delivery: "installed-app",
        },
        fixtureId: "ui:isolated-profile-empty-composer-screenshot",
        expectedEffect: "composer screenshot attaches an owned PNG",
        oracleId: "ui:activation:owned-app-screenshot-attached",
        cleanupId: "ui:remove-exact-screenshot-attachment-delete-owned-png-restore-view",
      },
    ],
  };
  writeFileSync(screenshotRequestPath, `${JSON.stringify(screenshotRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const screenshotDescribe = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-screenshot-attachment-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(screenshotDescribe.status, 0, screenshotDescribe.stderr || screenshotDescribe.stdout);
  assert.equal(JSON.parse(screenshotDescribe.stdout).invocationTransport, "native-installed-input");
  const screenshotRun = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-screenshot-attachment-installed.ts"),
    "--request", screenshotRequestPath,
    "--out", screenshotReportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(screenshotRun.status, 0, screenshotRun.stderr || screenshotRun.stdout);
  const screenshotReport = JSON.parse(readFileSync(screenshotReportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(screenshotReport.outcomes.length, 2);
  assert(screenshotReport.outcomes.every((outcome) => (
    outcome.present === "pass"
      && outcome.invoke === "pass"
      && outcome.effect === "pass"
      && outcome.cleanup === "pass"
      && outcome.observedEffect.includes("production app-window capture path")
  )));
  const screenshotAudit = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(screenshotAudit.status, 200);
  const screenshotAuditBody = await screenshotAudit.json() as typeof auditBody & { assetBoardOpen: boolean };
  assert.deepEqual(screenshotAuditBody.nativeClicks, [
    ...actionIds,
    "ui-screenshot:asset",
    "ui-screenshot:composer",
  ]);
  assert.equal(screenshotAuditBody.assetBoardOpen, false);
  assert.equal(screenshotAuditBody.attachmentActive, false);
  assert.equal(screenshotAuditBody.attachmentRemoveClicks, 3);
  assert.equal(screenshotAuditBody.screenshotFileExists, false);
  assert.equal(existsSync(baselineScreenshotPath), true);

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/palette-action-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(overwrite.status, 0, "palette evidence output must be create-only");

  console.log("Release surface native palette WebDriver tests passed");
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
      throw new Error(`palette fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("palette fixture did not publish its ports");
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
