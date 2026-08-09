import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-safe-families-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-control-safe-family-token-0001";
const sessionId = "fixture-ui-control-safe-family-session-0001";
const instanceId = "fixture-ui-control-safe-family-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureIds = new Set([
  "ui:connection-editor-closed",
  "ui:connection-editor-open",
  "ui:connection-editor-local-draft",
  "ui:connection-editor-choice-baseline",
  "ui:connection-editor-owned-vault-key",
  "ui:general-setting-owned-baseline",
  "ui:data-delete-dialog-closed",
  "ui:data-delete-dialog-open",
  "ui:data-delete-owned-section",
  "ui:builtin-doc-closed",
  "ui:builtin-doc-open",
  "ui:about-external-link-baseline",
  "ui:local-disclosure-owned-baseline",
  "ui:empty-project-list",
  "ui:owned-project-row-collapsed",
  "ui:owned-project-delete-dialog",
  "ui:connectors-draft-closed",
  "ui:connectors-unsaved-draft-open",
  "ui:connectors-unsaved-draft-baseline",
  "ui:shellx-tool-exposure-owned-baseline",
  "ui:lazy-surface-owned-error",
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
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const safeAssignments = plan.assignments
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
      && fixtureIds.has(assignment.fixtureId)
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `safe-family assignment ${assignment.surfaceId} must exist in exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(safeAssignments.length, 55, "the focused safe-family fixture must cover the exact promoted slice");
  assert.equal(new Set(safeAssignments.map((assignment) => assignment.surface.id)).size, 55);
  const connectorAssignments = safeAssignments.filter((assignment) => (
    assignment.surface.source === "src/components/settings/ConnectorsTab.tsx"
  ));
  assert.equal(connectorAssignments.length, 13);
  assert.deepEqual(
    new Set(connectorAssignments.map((assignment) => assignment.fixtureId)),
    new Set([
      "ui:connectors-draft-closed",
      "ui:connectors-unsaved-draft-open",
      "ui:connectors-unsaved-draft-baseline",
    ]),
  );

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
    "--profile-root", temp,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
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
      posixNative: releaseSurfacePosixNativeBindingFixture({ processId: 4321, port: Number(new URL(candidateBase).port), imagePath: "/tmp/fixture/shellx", imageSha256: "d".repeat(64) }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
    },
    assignments: safeAssignments,
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
  for (const id of [
    "ui:close-connection-editor-and-settings",
    "ui:clear-connection-draft-and-close-settings",
    "ui:restore-connection-draft-and-close-settings",
    "ui:clear-connection-vault-selection-delete-owned-key-and-close-settings",
    "ui:restore-general-setting-and-close-settings",
    "ui:close-data-delete-dialog-and-settings",
    "ui:restore-empty-user-data-and-close-settings",
    "ui:close-builtin-doc-and-settings",
    "ui:close-about-external-link-and-settings",
    "ui:restore-local-disclosure-and-close-owner",
    "ui:delete-owned-project-draft",
    "ui:delete-owned-project-marker",
    "ui:restore-connectors-draft-and-close-settings",
    "ui:restore-shellx-tool-exposure-and-right-rail",
    "ui:clear-lazy-surface-fixture",
  ]) assert(manifest.supportedCleanups.includes(id), `manifest is missing cleanup ${id}`);
  for (const id of [
    "ui:activation:connection-editor-opened",
    "ui:activation:connection-editor-closed",
    "ui:boolean-state-transition",
    "ui:range-state-transition",
    "ui:activation:general-setting-reset",
    "ui:activation:data-delete-dialog-opened",
    "ui:activation:data-delete-dialog-cancelled",
    "ui:activation:data-delete-owned-section-removed",
    "ui:activation:builtin-doc-opened",
    "ui:activation:builtin-doc-closed",
    "ui:activation:about-external-link-dispatched",
    "ui:activation:project-draft-created",
    "ui:activation:project-delete-dialog-opened",
    "ui:activation:project-marker-deleted",
    "ui:activation:connectors-draft-opened",
    "ui:activation:connectors-draft-closed",
    "ui:activation:lazy-surface-recovered",
    "ui:activation:lazy-surface-dismissed",
  ]) assert(manifest.supportedOracles.includes(id), `manifest is missing oracle ${id}`);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failedReport = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(
    run.status,
    0,
    failedReport ? JSON.stringify(failedReport, null, 2) : run.stderr || run.stdout,
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 55);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.toLowerCase().includes("native webdriver")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    settingsOpen: boolean;
    dataDeleteDialogOpen: boolean;
    dataDeleteReceipt: unknown;
    ownedUserData: Record<string, unknown>;
    pluginsOpen: boolean;
    connectionEditorOpen: boolean;
    connectionTransport: string;
    connectionRuntime: string;
    connectionSshKeyVaultRef: string;
    connectionVaultKeys: string[];
    connectionDraftValues: Record<string, string>;
    builtinDoc: string | null;
    pluginsTierExpanded: boolean;
    projectsExpanded: boolean;
    openChatsExpanded: boolean;
    pastChatsExpanded: boolean;
    ownedProjectDraft: boolean;
    ownedProjectRenaming: boolean;
    ownedProjectRenameValue: string;
    ownedProjectExpanded: boolean;
    ownedProjectDeleteDialog: boolean;
    publicSettings: Record<string, unknown>;
    rightTab: string;
    activeTab: Record<string, unknown>;
    connectorDraftOpen: boolean;
    connectorProvider: string;
    connectorEnabled: boolean;
    connectorDispatchMode: string;
    connectorTargetMode: string;
    connectorVaultKey: string;
    connectorAllowedIds: string;
    clickedSelectors: string[];
    aboutExternalUrls: string[];
  };
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.dataDeleteDialogOpen, false);
  assert.equal(audit.dataDeleteReceipt, null);
  assert.deepEqual(audit.ownedUserData, {});
  assert.equal(audit.pluginsOpen, false);
  assert.equal(audit.connectionEditorOpen, false);
  assert.equal(audit.connectionTransport, "local");
  assert.equal(audit.connectionRuntime, "posix");
  assert.equal(audit.connectionSshKeyVaultRef, "");
  assert.deepEqual(audit.connectionVaultKeys, []);
  assert(Object.values(audit.connectionDraftValues).every((value) => value === ""));
  assert.equal(audit.builtinDoc, null);
  assert.equal(audit.pluginsTierExpanded, true);
  assert.equal(audit.projectsExpanded, true);
  assert.equal(audit.openChatsExpanded, true);
  assert.equal(audit.pastChatsExpanded, true);
  assert.equal(audit.ownedProjectDraft, false);
  assert.equal(audit.ownedProjectRenaming, false);
  assert.equal(audit.ownedProjectRenameValue, "");
  assert.equal(audit.ownedProjectExpanded, false);
  assert.equal(audit.ownedProjectDeleteDialog, false);
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.shellxToolExposure, "nativeFirst");
  assert.equal(audit.connectorDraftOpen, false);
  assert.equal(audit.connectorProvider, "telegram");
  assert.equal(audit.connectorEnabled, false);
  assert.equal(audit.connectorDispatchMode, "inbox");
  assert.equal(audit.connectorTargetMode, "activeTab");
  assert.equal(audit.connectorVaultKey, "telegram/bot-token");
  assert.equal(audit.connectorAllowedIds, "");
  assert.deepEqual(audit.publicSettings, {
    browserDownloadFolder: "",
    chatFontPx: 19,
    density: "default",
    githubGhBinary: "gh",
    permissionUx: "pill",
    theme: "black",
  });
  assert(audit.clickedSelectors.includes("[title='Add a new connection preset']"));
  assert(audit.clickedSelectors.includes("[title='Add a new connection']"));
  assert(audit.clickedSelectors.includes("[title='Read bundled release notes']"));
  assert(audit.clickedSelectors.includes("[title^='Delete the '][title$=' on disk + in localStorage']"));
  assert(audit.clickedSelectors.includes("[id='data-delete-cancel']"));
  assert(audit.clickedSelectors.includes("[id='data-delete-confirm']"));
  assert.deepEqual(audit.aboutExternalUrls, [
    "https://docs.theshellx.com/manual/shellx/",
    "https://github.com/martinsbrezauckis/shellx/issues",
    "https://theshellx.com",
    "https://x.com/theshellx",
    "https://github.com/martinsbrezauckis/shellx",
  ]);
  assert(audit.clickedSelectors.includes(":is([title='Collapse tier'],[title='Expand tier'])"));
  assert(audit.clickedSelectors.includes(":is([title='Collapse all projects'],[title='Expand all projects'])"));
  assert(audit.clickedSelectors.includes(":is([title='Hide open chats — drop here to unfile'],[title='Show open chats — drop here to unfile'])"));
  assert(audit.clickedSelectors.includes("[data-debug-id='left-past-chats-toggle']"));
  assert(!audit.clickedSelectors.includes("[data-debug-id='left-add-project']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-settings-connectorstab-3'][data-provider-kind='discord']"));
  assert(audit.clickedSelectors.includes("[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])"));
  assert(audit.clickedSelectors.includes("[aria-label='Cancel connector draft']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-rightrail-2'][data-shellx-tool-exposure='off']"));
  assert(!audit.clickedSelectors.some((selector) => (
    selector.includes("connectioneditor-12")
    || selector.includes("connectioneditor-14")
    || selector.includes("connectioneditor-16")
    || selector.includes("Save")
    || selector.includes("Submit")
    || selector.includes("connectorstab-12")
    || selector.includes("connectorstab-17")
    || selector.includes("connectorstab-18")
    || selector.includes("connector-secret")
    || selector.includes("connectorstab-11")
  )), "safe-family fixture must never scan, test, save, or submit a Connection Editor draft");

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "safe-family evidence output must remain create-only");

  console.log("Release surface safe UI-control native WebDriver families passed: 55 exact assignments");
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
      throw new Error(`safe-family fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("safe-family fixture did not publish its ports");
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
