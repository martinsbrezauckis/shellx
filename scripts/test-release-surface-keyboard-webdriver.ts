import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleasePlatform } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-keyboard-webdriver-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const token = "fixture-keyboard-native-webdriver-token-0001";
const sessionId = "fixture-keyboard-session-0001";
const instanceId = "fixture-keyboard-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const shortcuts = [
  "help",
  "escape",
  "palette",
  "settings",
  "toggle-terminal",
  "new-session",
  "close-session",
  "diff-next",
  "diff-prev",
  "diff-accept",
  "diff-reject",
];
const oracleIds: Record<string, string> = {
  help: "keyboard:help:dialog-visible",
  escape: "keyboard:escape:modal-closed",
  palette: "keyboard:palette:dialog-visible",
  settings: "keyboard:settings:dialog-visible",
  "toggle-terminal": "keyboard:toggle-terminal:state-transition",
  "new-session": "keyboard:new-session:state-transition",
  "close-session": "keyboard:close-session:state-transition",
  "diff-next": "keyboard:diff-next:diff-hunk-effect",
  "diff-prev": "keyboard:diff-prev:diff-hunk-effect",
  "diff-accept": "keyboard:diff-accept:diff-hunk-effect",
  "diff-reject": "keyboard:diff-reject:diff-hunk-effect",
};
const fixtures: Record<string, string> = {
  escape: "keyboard:settings-visible",
  "toggle-terminal": "keyboard:chat-bottom-tab",
  "new-session": "keyboard:session-baseline",
  "close-session": "keyboard:session-baseline",
  "diff-next": "keyboard:owned-renderer-diff",
  "diff-prev": "keyboard:owned-renderer-diff",
  "diff-accept": "keyboard:owned-renderer-diff",
  "diff-reject": "keyboard:owned-renderer-diff",
};
const cleanups: Record<string, string> = {
  escape: "keyboard:modal-closed",
  "toggle-terminal": "keyboard:restore-chat-bottom-tab",
  "new-session": "keyboard:restore-session-baseline",
  "close-session": "keyboard:restore-session-baseline",
  "diff-next": "keyboard:clear-owned-renderer-diff-and-restore-tabs",
  "diff-prev": "keyboard:clear-owned-renderer-diff-and-restore-tabs",
  "diff-accept": "keyboard:clear-owned-renderer-diff-and-restore-tabs",
  "diff-reject": "keyboard:clear-owned-renderer-diff-and-restore-tabs",
};
let fixture: ChildProcess | null = null;

try {
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-keyboard-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", "0.3.5",
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/keyboard-shortcut-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  assert.equal(JSON.parse(described.stdout).invocationTransport, "native-installed-input");

  const linuxRequest = request("linux-installed", shortcuts, candidateBase, webdriverBase);
  const linuxReport = runDriver("linux", linuxRequest);
  assert.equal(linuxReport.outcomes.length, shortcuts.length);
  assert(linuxReport.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("native")
  )));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    chords: string[][];
    releaseCount: number;
    neutralFocusClicks: number;
    modal: string | null;
    bottomTab: string;
    activeTabId: string;
    openTabs: Array<{ tabId: string }>;
    diffSessionOpen: boolean;
    activeHunkIndex: number;
    hunkAudit: Record<string, string>;
    hunkClicks: number[];
    refreshCount: number;
  };
  assert.deepEqual(audit.chords, [
    ["?"],
    ["\uE00C"],
    ["\uE009", "k"],
    ["\uE009", ","],
    ["\uE009", "`"],
    ["\uE009", "t"],
    ["\uE009", "w"],
    ["\uE009", "t"],
    ["\uE009", "w"],
    ["j"],
    ["k"],
    ["y"],
    ["y"],
    ["n"],
    ["n"],
  ]);
  assert.equal(audit.releaseCount, audit.chords.length, "every key chord must release its input source");
  assert.equal(audit.neutralFocusClicks, 9, "global and diff shortcuts must establish neutral focus through WebDriver");
  assert.equal(audit.modal, null);
  assert.equal(audit.bottomTab, "Chat");
  assert.equal(audit.activeTabId, "fixture-tab-1");
  assert.deepEqual(audit.openTabs, [{ tabId: "fixture-tab-1" }]);
  assert.equal(audit.diffSessionOpen, false);
  assert.equal(audit.activeHunkIndex, 0);
  assert.deepEqual(audit.hunkAudit, {});
  assert.deepEqual(audit.hunkClicks, [0, 0, 1, 0, 0, 0, 0, 0]);
  assert.equal(audit.refreshCount, 0, "renderer-only diff setup must not touch stored-session refresh state");

  console.log("Release surface native keyboard WebDriver tests passed");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function request(
  platform: ReleasePlatform,
  ids: string[],
  candidateBase: string,
  webdriverBase: string,
): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "keyboard-shortcut-installed",
    driverKind: "keyboard-shortcut",
    platform,
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/keyboard-shortcut-installed.ts", [
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
      "src/lib/debug-renderer-fixture.ts",
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
      posixNative: releaseSurfacePosixNativeBindingFixture({
        platform: platform === "macos-installed" ? "macos" : "linux",
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
    assignments: ids.map((id) => ({
      surface: {
        id: `keyboard-shortcut:${id}`,
        kind: "keyboard-shortcut",
        name: id,
        source: "src/lib/shortcuts.ts",
        platforms: ["linux-installed", "windows-installed", "macos-installed"],
        delivery: "installed-app",
      },
      fixtureId: fixtures[id] ?? "keyboard:app-shell-visible",
      expectedEffect: `${id} produces its exact native keyboard effect`,
      oracleId: oracleIds[id]!,
      cleanupId: cleanups[id] ?? "keyboard:close-modal",
    })),
  };
}

function runDriver(stem: string, requestValue: ReleaseSurfaceDriverRequest): ReleaseSurfaceDriverReport {
  const requestPath = join(temp, `${stem}-request.json`);
  const reportPath = join(temp, `${stem}-report.json`);
  writeFileSync(requestPath, `${JSON.stringify(requestValue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/keyboard-shortcut-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(report.nativeWebDriver, requestValue.nativeWebDriver);
  return report;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`keyboard fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("keyboard fixture did not publish its ports");
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
