import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-owned-bookmarks-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-control-owned-bookmark-token-0001";
const sessionId = "fixture-ui-control-owned-bookmark-session-0001";
const instanceId = "fixture-ui-control-owned-bookmark-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureIds = new Set([
  "ui:browser-bookmark-owned-row",
  "ui:browser-bookmark-owned-folder-choice",
  "ui:browser-bookmark-owned-create",
  "ui:browser-owned-history-sidecar",
  "ui:browser-history-clear-sheet-owned-baseline",
  "ui:browser-bookmark-owned-navigation",
]);
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
  const bookmarkNavigationSource = readFileSync(join(root, "scripts/release-drivers/ui-control-owned-browser-bookmark-navigation.ts"), "utf8");
  assert(bookmarkNavigationSource.includes('expectedDomains: ["127.0.0.1"]'), "owned bookmark navigation must scope its private loopback target");
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignmentsBySurfaceId = new Map(plan.assignments
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
      && fixtureIds.has(assignment.fixtureId)
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `owned Bookmark assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return [assignment.surfaceId, {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      }] as const;
    }));
  for (const [surfaceId, fixtureId, expectedEffect, oracleId, cleanupId] of [
    [
      "ui-control:src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-clear-all-history\"]@src/browser/components/BrowserHistorySidecar.tsx#7",
      "ui:browser-history-clear-sheet-owned-baseline",
      "Native input opens the exact All-history confirmation sheet over a mixed owned User and Agent history baseline without removing either class before exact panel, scope, task, personal tab, loopback server, and window restoration.",
      "ui:activation:owned-browser-history-all-clear-sheet",
      "ui:restore-owned-browser-history-clear-sheet",
    ],
    [
      "ui-control:src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-cancel\"]@src/browser/components/BrowserHistorySidecar.tsx#9",
      "ui:browser-history-clear-sheet-owned-baseline",
      "Native input cancels the exact All-history confirmation sheet over a mixed owned User and Agent history baseline and preserves both classes before exact panel, scope, task, personal tab, loopback server, and window restoration.",
      "ui:activation:owned-browser-history-clear-cancel",
      "ui:restore-owned-browser-history-clear-sheet",
    ],
    [
      "ui-control:src/browser/components/BrowserHistorySidecar.tsx:[data-debug-id=\"shellx-browser-history-clear-confirm\"]@src/browser/components/BrowserHistorySidecar.tsx#10",
      "ui:browser-history-clear-sheet-owned-baseline",
      "Native input confirms the exact All-history sheet over a mixed owned User and Agent history baseline, then verifies the all-scope receipt and success status before exact panel, scope, task, personal tab, loopback server, and window restoration.",
      "ui:activation:owned-browser-history-all-clear-receipt",
      "ui:restore-owned-browser-history-clear-sheet",
    ],
  ] as const) {
    const surface = inventoryById.get(surfaceId);
    assert(surface, `mixed-history assignment ${surfaceId} must exist in the exact inventory`);
    const existing = assignmentsBySurfaceId.get(surfaceId);
    if (existing) {
      assert.deepEqual(
        [existing.fixtureId, existing.expectedEffect, existing.oracleId, existing.cleanupId],
        [fixtureId, expectedEffect, oracleId, cleanupId],
        `generated plan mapping drifted for ${surfaceId}`,
      );
    } else {
      assignmentsBySurfaceId.set(surfaceId, { surface, fixtureId, expectedEffect, oracleId, cleanupId });
    }
  }
  const assignments = [...assignmentsBySurfaceId.values()];
  assert.equal(assignments.length, 19, "the owned Bookmark/history fixture must cover sixteen existing and three mixed-history clear controls");
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 19);
  assert(assignments.every((assignment) => [
    "ui:delete-owned-bookmarks-restore-panel-abort-task-and-window",
    "ui:clear-owned-browser-history-abort-task-and-window-loopback",
    "ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback",
    "ui:restore-owned-browser-history-clear-sheet",
  ].includes(assignment.cleanupId)));

  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-owned-bookmarks-server-fixture.ts"),
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
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-installed.ts", [
      "scripts/shellx-browser-test-cleanup.ts",
      "scripts/lib/release-surface-installed-input-client.ts",
      "scripts/lib/release-surface-bounded-observation.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
      "scripts/lib/release-surface-tauri-invoke-client.ts",
      "scripts/release-drivers/debug-api-session-fixture.ts",
      "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts",
      "scripts/release-drivers/ui-control-owned-browser-history.ts",
      "scripts/release-drivers/ui-control-browser-personal-lock-settings.ts",
      "scripts/release-drivers/ui-control-owned-browser-bookmark-navigation.ts",
      "scripts/release-drivers/ui-control-browser-ad-modes.ts",
      "scripts/release-drivers/ui-control-browser-shields.ts",
      "scripts/release-drivers/ui-control-safe-families.ts",
      "scripts/release-drivers/ui-control-safe-vault-drafts.ts",
      "scripts/release-drivers/ui-control-vault-owned-edit.ts",
      "scripts/release-drivers/ui-control-find-new-tab.ts",
      "scripts/release-drivers/ui-control-file-preview-safe.ts",
      "scripts/release-drivers/ui-control-attachment-media-safe.ts",
      "scripts/release-drivers/ui-control-setup-guide.ts",
      "scripts/release-drivers/ui-control-work-preview-kind.ts",
      "scripts/release-drivers/ui-control-work-preview-running.ts",
      "scripts/release-drivers/ui-control-work-preview-safe.ts",
      "scripts/release-drivers/ui-control-work-preview-start.ts",
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
        processId: 4321,
        port: ports.candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "d".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: `http://127.0.0.1:${ports.webdriverPort}`,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments,
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert([...fixtureIds].every((id) => manifest.supportedFixtures.includes(id)));
  assert(manifest.supportedCleanups.includes("ui:delete-owned-bookmarks-restore-panel-abort-task-and-window"));
  assert(manifest.supportedCleanups.includes("ui:clear-owned-browser-history-abort-task-and-window-loopback"));
  assert(manifest.supportedCleanups.includes("ui:restore-owned-browser-history-clear-sheet"));
  assert(manifest.supportedCleanups.includes("ui:delete-owned-bookmark-navigation-abort-task-and-window-loopback"));
  for (const id of [
    "ui:value-state-transition",
    "ui:choice-state-transition",
    "ui:activation:owned-bookmark-pin-state-transition",
    "ui:activation:owned-bookmark-state-transition",
    "ui:activation:owned-bookmark-order-transition",
    "ui:activation:owned-browser-history-entry-navigation",
    "ui:activation:owned-browser-history-clear",
    "ui:activation:owned-browser-history-all-clear-sheet",
    "ui:activation:owned-browser-history-clear-cancel",
    "ui:activation:owned-browser-history-all-clear-receipt",
    "ui:activation:owned-browser-bookmark-created",
    "ui:activation:owned-browser-bookmark-navigation",
  ]) assert(manifest.supportedOracles.includes(id), `manifest is missing oracle ${id}`);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 19);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.toLowerCase().includes("installed input")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    bookmarks: unknown[];
    labelDrafts: Record<string, string>;
    urlDrafts: Record<string, string>;
    taskStatus: string;
    browserWindowOpen: boolean;
    currentWindow: string;
    disclosureOpen: boolean;
    manageMode: boolean;
    draftLabel: string;
    draftUrl: string;
    draftFolder: string;
    deleteConfirmationId: string | null;
    tabs: unknown[];
    activeBrowserTabId: string | null;
    clickedSelectors: string[];
    draggedSelectors: Array<{ source: string; target: string }>;
    historyEntries: unknown[];
    historyOpen: boolean;
    historyScope: string;
    pendingHistoryClearScope: string | null;
    historyClearStatus: { tone: string; message: string } | null;
    historyClearReceipts: Array<{ kind: string; evidence: { scope: string; removed: number } }>;
    openToolbarFolderId: string | null;
  };
  assert.deepEqual(audit.bookmarks, []);
  assert.deepEqual(audit.labelDrafts, {});
  assert.deepEqual(audit.urlDrafts, {});
  assert.equal(audit.taskStatus, "aborted");
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.disclosureOpen, false);
  assert.equal(audit.manageMode, false);
  assert.equal(audit.draftLabel, "");
  assert.equal(audit.draftUrl, "");
  assert.equal(audit.draftFolder, "");
  assert.equal(audit.deleteConfirmationId, null);
  assert.deepEqual(audit.tabs, []);
  assert.equal(audit.activeBrowserTabId, null);
  assert.deepEqual(audit.historyEntries, []);
  assert.equal(audit.historyOpen, false);
  assert.equal(audit.historyScope, "user");
  assert.equal(audit.pendingHistoryClearScope, null);
  assert.deepEqual(audit.historyClearStatus, { tone: "success", message: "Cleared 4 Browser history entries." });
  const allScopeReceipts = audit.historyClearReceipts.filter((receipt) => receipt.evidence.scope === "all");
  assert.deepEqual(allScopeReceipts.slice(0, 3), [
    { kind: "browserHistoryCleared", evidence: { scope: "all", removed: 4 } },
    { kind: "browserHistoryCleared", evidence: { scope: "all", removed: 4 } },
    { kind: "browserHistoryCleared", evidence: { scope: "all", removed: 4 } },
  ], "the Confirm assignment and exact owned cleanup must retain the all-scope receipt payload");
  assert.equal(audit.openToolbarFolderId, null);
  assert.deepEqual(audit.draggedSelectors, [{
    source: "[data-debug-id='shellx-browser-bookmark-drag-final-surface-ui-control-drag-second']",
    target: "[data-debug-id='shellx-browser-bookmark-manager-row-final-surface-ui-control-drag-first']",
  }]);
  for (const selector of [
    "[data-debug-id='shellx-browser-bookmark-create-folder']",
    "[data-debug-id='shellx-browser-bookmark-create-link']",
    "[data-debug-id='shellx-browser-bookmark-pin-final-surface-ui-control-link']",
    "[data-debug-id='shellx-browser-bookmark-delete-final-surface-ui-control-link']",
    "[data-debug-id='shellx-browser-clear-history']",
    "[data-debug-id='shellx-browser-clear-all-history']",
    "[data-debug-id='shellx-browser-history-clear-cancel']",
    "[data-debug-id='shellx-browser-history-clear-confirm']",
    "[data-debug-id='shellx-browser-bookmark-current']",
    "[data-debug-id='shellx-browser-bookmark-folder-final-surface-navigation-folder']",
    "[data-debug-id='shellx-browser-bookmark-toolbar-link-final-surface-navigation-link']",
    "[data-debug-id='shellx-browser-bookmark-folder-child-final-surface-navigation-child']",
    "[data-debug-id='shellx-browser-bookmark-final-surface-navigation-link']",
    "[data-debug-id='shellx-browser-bookmark-open-final-surface-navigation-link'][aria-label='Open Final surface navigation link']",
  ]) assert(audit.clickedSelectors.includes(selector), `fixture did not observe ${selector}`);

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.notEqual(overwrite.status, 0, "owned Bookmark evidence output must remain create-only");

  console.log("Release surface owned Bookmark/history UI controls passed: 19 exact assignments including scoped All-sheet cancel, receipt, status, and cleanup proof");
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
      throw new Error(`owned Bookmark fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("owned Bookmark fixture did not publish its ports");
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
