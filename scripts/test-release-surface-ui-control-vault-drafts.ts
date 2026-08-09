import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { UI_CONTROL_INSTALLED_CONTROLLER_FILES } from "./release-drivers/ui-control-installed-manifest";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-control-vault-drafts-"));
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(temp, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const boundedRequestPath = join(temp, "bounded-request.json");
const boundedReportPath = join(temp, "bounded-report.json");
const token = "fixture-ui-control-vault-draft-token-0001";
const sessionId = "fixture-ui-control-vault-draft-session-0001";
const instanceId = "fixture-ui-control-vault-draft-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureIds = new Set([
  "ui:vault-unsaved-draft-text-baseline",
  "ui:vault-unsaved-draft-choice-baseline",
  "ui:vault-unsaved-draft-permission-baseline",
  "ui:vault-setup-recovery-action",
  "ui:vault-setup-recovery-import-choice",
  "ui:vault-setup-recovery-confirm-action",
  "ui:vault-configured-change-setup-action",
  "ui:vault-configured-unlock-passphrase",
  "ui:vault-configured-unlock-remember-device",
  "ui:vault-configured-unlock-action",
  "ui:vault-configured-remember-passphrase",
  "ui:vault-configured-remember-device-enable",
  "ui:vault-configured-forget-device",
  "ui:vault-workspace-lock-action",
  "ui:vault-workspace-unlock-passphrase",
  "ui:vault-workspace-unlock-action",
  "ui:vault-grants-refresh-owned-grants",
  "ui:vault-grants-revoke-owned-grant",
]);
const syntheticGrantValues = [
  "SHELLX_RELEASE_SYNTHETIC_GRANT_VALUE_A_035",
  "SHELLX_RELEASE_SYNTHETIC_GRANT_VALUE_B_035",
] as const;
const baselineChoices = {
  "[data-debug-id='surface-components-settings-vaulttab-45']": false,
  "[data-debug-id='surface-components-settings-vaulttab-48']": "test",
  "[data-debug-id='surface-components-settings-vaulttab-57']": "dryRun",
  "[data-debug-id='surface-components-settings-vaulttab-59']": false,
  "[data-debug-id='vault-permission-visible']": true,
  "[data-debug-id='vault-permission-userOnly']": false,
  "[data-debug-id='vault-permission-toolUseAlways']": false,
  "[data-debug-id='vault-permission-browserFillAlways']": false,
};
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
  const targetSurfaces = inventory.items.filter((surface) => (
    surface.source.endsWith("VaultSetupPanel.tsx") || surface.source.endsWith("VaultGrantsPanel.tsx")
  ));
  const targetIds = new Set(targetSurfaces.map((surface) => surface.id));
  const targetAssignments = plan.assignments.filter((assignment) => targetIds.has(assignment.surfaceId));
  assert.equal(targetSurfaces.length, 43, "Vault Setup and Grants must retain exactly 43 inventoried controls and debug markers");
  assert.equal(targetAssignments.length, 43);
  assert.equal(targetAssignments.filter((assignment) => !assignment.driverId.includes("backlog")).length, 43);
  const targetBacklog = targetAssignments.filter((assignment) => assignment.driverId.includes("backlog"));
  assert.equal(targetBacklog.length, 0, "every Vault Setup and Grants surface must have an exact executable lane");
  const assignments = plan.assignments
    .filter((assignment) => (
      (assignment.driverId === "ui-control-installed" || assignment.driverId === "ui-control-bounded-installed")
      && fixtureIds.has(assignment.fixtureId)
    ))
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Vault draft assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 58, "the Vault fixture must cover exactly 43 safe drafts and fifteen lifecycle controls");
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 58);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId.endsWith("text-baseline")).length, 32);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId.endsWith("choice-baseline")).length, 7);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId.endsWith("permission-baseline")).length, 4);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-import-choice").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-confirm-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-change-setup-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-passphrase").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-remember-device").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-remember-passphrase").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-remember-device-enable").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-configured-forget-device").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-workspace-lock-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-workspace-unlock-passphrase").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-workspace-unlock-action").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-grants-refresh-owned-grants").length, 1);
  assert.equal(assignments.filter((assignment) => assignment.fixtureId === "ui:vault-grants-revoke-owned-grant").length, 1);
  assert(assignments.every((assignment) => assignment.expectedEffect.includes(
    assignment.fixtureId === "ui:vault-setup-recovery-action"
      ? "without observing recovery words"
      : assignment.fixtureId === "ui:vault-setup-recovery-import-choice"
        ? "setup is never confirmed and recovery words are never observed"
      : assignment.fixtureId === "ui:vault-setup-recovery-confirm-action"
        ? "without observing recovery words"
      : assignment.fixtureId === "ui:vault-configured-change-setup-action"
        ? "remains configured and unlocked"
      : assignment.fixtureId === "ui:vault-configured-unlock-passphrase"
        ? "remains configured and locked"
      : assignment.fixtureId === "ui:vault-configured-unlock-remember-device"
        ? "device remembering stays disabled"
      : assignment.fixtureId === "ui:vault-configured-unlock-action"
        ? "device remembering remains disabled"
      : assignment.fixtureId === "ui:vault-configured-remember-passphrase"
        ? "device remembering stays disabled"
      : assignment.fixtureId === "ui:vault-configured-remember-device-enable"
        ? "isolated disposable Vault namespace"
      : assignment.fixtureId === "ui:vault-configured-forget-device"
        ? "isolated disposable Vault namespace"
      : assignment.fixtureId === "ui:vault-workspace-lock-action"
        ? "keeps device remembering disabled"
      : assignment.fixtureId === "ui:vault-workspace-unlock-passphrase"
        ? "remains configured and locked"
      : assignment.fixtureId === "ui:vault-workspace-unlock-action"
        ? "without silently enabling remembered-device credentials"
      : assignment.fixtureId === "ui:vault-grants-refresh-owned-grants"
        ? "without reading secret values"
      : assignment.fixtureId === "ui:vault-grants-revoke-owned-grant"
        ? "without reading secret values"
      : assignment.fixtureId.endsWith("permission-baseline")
      ? "no Vault save, credential, or grant action is invoked"
      : assignment.surface.source.endsWith("VaultSetupPanel.tsx")
        ? "no Vault setup, save, credential, grant, or permission action is invoked"
        : "no Vault save, credential, grant, or permission action is invoked",
  )));

  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-vault-draft-server-fixture.ts"),
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
  assert(manifest.supportedCleanups.includes("ui:restore-vault-unsaved-draft-and-settings-owner"));
  assert(manifest.supportedCleanups.includes("ui:reset-disposable-vault-and-close-settings"));
  for (const id of [
    "ui:value-state-transition",
    "ui:choice-state-transition",
    "ui:boolean-state-transition",
    "ui:activation:vault-recovery-kit-created",
    "ui:activation:vault-recovery-confirmed",
    "ui:activation:vault-change-setup-opened",
    "ui:activation:vault-unlocked",
    "ui:activation:vault-locked",
    "ui:activation:vault-remembered-device-enabled",
    "ui:activation:vault-remembered-device-disabled",
    "ui:activation:vault-grants-refreshed",
    "ui:activation:vault-grant-revoked",
  ]) {
    assert(manifest.supportedOracles.includes(id), `manifest is missing oracle ${id}`);
  }

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 300_000 });
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(
    run.status,
    0,
    [run.error?.message, run.stderr, run.stdout, reportText]
      .filter(Boolean)
      .join("\n"),
  );
  const report: ReleaseSurfaceDriverReport = JSON.parse(reportText);
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, report), []);
  assert.equal(report.outcomes.length, 58);
  assert(syntheticGrantValues.every((value) => !JSON.stringify(report).includes(value)), "report must not retain synthetic Vault grant values");
  const recoveryAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-action");
  assert(recoveryAssignment);
  const recoveryOutcome = report.outcomes.find((outcome) => outcome.id === recoveryAssignment.surface.id);
  assert(recoveryOutcome);
  assert.deepEqual(
    [recoveryOutcome.present, recoveryOutcome.invoke, recoveryOutcome.effect, recoveryOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    recoveryOutcome.error,
  );
  assert(recoveryOutcome.observedEffect.includes("one disposable Vault recovery challenge"));
  assert(recoveryOutcome.observedEffect.includes("recovery words were never observed"));
  const importAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-import-choice");
  assert(importAssignment);
  const importOutcome = report.outcomes.find((outcome) => outcome.id === importAssignment.surface.id);
  assert(importOutcome);
  assert.deepEqual(
    [importOutcome.present, importOutcome.invoke, importOutcome.effect, importOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    importOutcome.error,
  );
  assert(importOutcome.observedEffect.includes("legacy-import choice"));
  assert(importOutcome.observedEffect.includes("without confirming setup or observing recovery words"));
  const confirmAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-setup-recovery-confirm-action");
  assert(confirmAssignment);
  const confirmOutcome = report.outcomes.find((outcome) => outcome.id === confirmAssignment.surface.id);
  assert(confirmOutcome);
  assert.deepEqual(
    [confirmOutcome.present, confirmOutcome.invoke, confirmOutcome.effect, confirmOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    confirmOutcome.error,
  );
  assert(confirmOutcome.observedEffect.includes("configured summary"));
  assert(confirmOutcome.observedEffect.includes("without observing recovery words"));
  const changeSetupAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-change-setup-action");
  assert(changeSetupAssignment);
  const changeSetupOutcome = report.outcomes.find((outcome) => outcome.id === changeSetupAssignment.surface.id);
  assert(changeSetupOutcome);
  assert.deepEqual(
    [changeSetupOutcome.present, changeSetupOutcome.invoke, changeSetupOutcome.effect, changeSetupOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    changeSetupOutcome.error,
  );
  assert(changeSetupOutcome.observedEffect.includes("setup form"));
  assert(changeSetupOutcome.observedEffect.includes("remained configured and unlocked"));
  const unlockPassphraseAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-passphrase");
  assert(unlockPassphraseAssignment);
  const unlockPassphraseOutcome = report.outcomes.find((outcome) => outcome.id === unlockPassphraseAssignment.surface.id);
  assert(unlockPassphraseOutcome);
  assert.deepEqual(
    [unlockPassphraseOutcome.present, unlockPassphraseOutcome.invoke, unlockPassphraseOutcome.effect, unlockPassphraseOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    unlockPassphraseOutcome.error,
  );
  assert(unlockPassphraseOutcome.observedEffect.includes("passphrase draft"));
  assert(unlockPassphraseOutcome.observedEffect.includes("configured and locked"));
  const unlockRememberAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-remember-device");
  assert(unlockRememberAssignment);
  const unlockRememberOutcome = report.outcomes.find((outcome) => outcome.id === unlockRememberAssignment.surface.id);
  assert(unlockRememberOutcome);
  assert.deepEqual(
    [unlockRememberOutcome.present, unlockRememberOutcome.invoke, unlockRememberOutcome.effect, unlockRememberOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    unlockRememberOutcome.error,
  );
  assert(unlockRememberOutcome.observedEffect.includes("remember-device choice"));
  assert(unlockRememberOutcome.observedEffect.includes("device remembering stayed disabled"));
  const unlockAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-unlock-action");
  assert(unlockAssignment);
  const unlockOutcome = report.outcomes.find((outcome) => outcome.id === unlockAssignment.surface.id);
  assert(unlockOutcome);
  assert.deepEqual(
    [unlockOutcome.present, unlockOutcome.invoke, unlockOutcome.effect, unlockOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    unlockOutcome.error,
  );
  assert(unlockOutcome.observedEffect.includes("unlocked the configured disposable Vault"));
  assert(unlockOutcome.observedEffect.includes("device remembering remained disabled"));
  const rememberPassphraseAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-remember-passphrase");
  assert(rememberPassphraseAssignment);
  const rememberPassphraseOutcome = report.outcomes.find((outcome) => outcome.id === rememberPassphraseAssignment.surface.id);
  assert(rememberPassphraseOutcome);
  assert.deepEqual(
    [rememberPassphraseOutcome.present, rememberPassphraseOutcome.invoke, rememberPassphraseOutcome.effect, rememberPassphraseOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    rememberPassphraseOutcome.error,
  );
  assert(rememberPassphraseOutcome.observedEffect.includes("remembered-device passphrase draft"));
  assert(rememberPassphraseOutcome.observedEffect.includes("device remembering stayed disabled"));
  const rememberEnableAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-remember-device-enable");
  assert(rememberEnableAssignment);
  const rememberEnableOutcome = report.outcomes.find((outcome) => outcome.id === rememberEnableAssignment.surface.id);
  assert(rememberEnableOutcome);
  assert.deepEqual(
    [rememberEnableOutcome.present, rememberEnableOutcome.invoke, rememberEnableOutcome.effect, rememberEnableOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    rememberEnableOutcome.error,
  );
  assert(rememberEnableOutcome.observedEffect.includes("enabled remembered-device credentials"));
  assert(rememberEnableOutcome.observedEffect.includes("disposable Vault namespace"));
  const forgetDeviceAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-configured-forget-device");
  assert(forgetDeviceAssignment);
  const forgetDeviceOutcome = report.outcomes.find((outcome) => outcome.id === forgetDeviceAssignment.surface.id);
  assert(forgetDeviceOutcome);
  assert.deepEqual(
    [forgetDeviceOutcome.present, forgetDeviceOutcome.invoke, forgetDeviceOutcome.effect, forgetDeviceOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    forgetDeviceOutcome.error,
  );
  assert(forgetDeviceOutcome.observedEffect.includes("removed remembered-device credentials"));
  assert(forgetDeviceOutcome.observedEffect.includes("disposable Vault namespace"));
  const workspaceLockAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-workspace-lock-action");
  assert(workspaceLockAssignment);
  const workspaceLockOutcome = report.outcomes.find((outcome) => outcome.id === workspaceLockAssignment.surface.id);
  assert(workspaceLockOutcome);
  assert.deepEqual(
    [workspaceLockOutcome.present, workspaceLockOutcome.invoke, workspaceLockOutcome.effect, workspaceLockOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    workspaceLockOutcome.error,
  );
  assert(workspaceLockOutcome.observedEffect.includes("locked the configured disposable Vault workspace"));
  assert(workspaceLockOutcome.observedEffect.includes("without enabling device remembering"));
  const workspacePassphraseAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-workspace-unlock-passphrase");
  assert(workspacePassphraseAssignment);
  const workspacePassphraseOutcome = report.outcomes.find((outcome) => outcome.id === workspacePassphraseAssignment.surface.id);
  assert(workspacePassphraseOutcome);
  assert.deepEqual(
    [workspacePassphraseOutcome.present, workspacePassphraseOutcome.invoke, workspacePassphraseOutcome.effect, workspacePassphraseOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    workspacePassphraseOutcome.error,
  );
  assert(workspacePassphraseOutcome.observedEffect.includes("workspace passphrase draft"));
  assert(workspacePassphraseOutcome.observedEffect.includes("configured and locked"));
  const workspaceUnlockAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-workspace-unlock-action");
  assert(workspaceUnlockAssignment);
  const workspaceUnlockOutcome = report.outcomes.find((outcome) => outcome.id === workspaceUnlockAssignment.surface.id);
  assert(workspaceUnlockOutcome);
  assert.deepEqual(
    [workspaceUnlockOutcome.present, workspaceUnlockOutcome.invoke, workspaceUnlockOutcome.effect, workspaceUnlockOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    workspaceUnlockOutcome.error,
  );
  assert(workspaceUnlockOutcome.observedEffect.includes("unlocked the configured disposable Vault workspace"));
  assert(workspaceUnlockOutcome.observedEffect.includes("without silently enabling remembered-device credentials"));
  const grantsRefreshAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-grants-refresh-owned-grants");
  assert(grantsRefreshAssignment);
  const grantsRefreshOutcome = report.outcomes.find((outcome) => outcome.id === grantsRefreshAssignment.surface.id);
  assert(grantsRefreshOutcome);
  assert.deepEqual(
    [grantsRefreshOutcome.present, grantsRefreshOutcome.invoke, grantsRefreshOutcome.effect, grantsRefreshOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    grantsRefreshOutcome.error,
  );
  assert(grantsRefreshOutcome.observedEffect.includes("one rendered owned grant"));
  assert(grantsRefreshOutcome.observedEffect.includes("exact two-grant backend state"));
  const grantRevokeAssignment = assignments.find((assignment) => assignment.fixtureId === "ui:vault-grants-revoke-owned-grant");
  assert(grantRevokeAssignment);
  const grantRevokeOutcome = report.outcomes.find((outcome) => outcome.id === grantRevokeAssignment.surface.id);
  assert(grantRevokeOutcome);
  assert.deepEqual(
    [grantRevokeOutcome.present, grantRevokeOutcome.invoke, grantRevokeOutcome.effect, grantRevokeOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    grantRevokeOutcome.error,
  );
  assert(grantRevokeOutcome.observedEffect.includes("revoked exactly one approved grant"));
  assert(grantRevokeOutcome.observedEffect.includes("never read the synthetic secret value"));
  const recoveryIds = new Set([
    recoveryAssignment.surface.id,
    importAssignment.surface.id,
    confirmAssignment.surface.id,
    changeSetupAssignment.surface.id,
    unlockPassphraseAssignment.surface.id,
    unlockRememberAssignment.surface.id,
    unlockAssignment.surface.id,
    rememberPassphraseAssignment.surface.id,
    rememberEnableAssignment.surface.id,
    forgetDeviceAssignment.surface.id,
    workspaceLockAssignment.surface.id,
    workspacePassphraseAssignment.surface.id,
    workspaceUnlockAssignment.surface.id,
    grantsRefreshAssignment.surface.id,
    grantRevokeAssignment.surface.id,
  ]);
  assert(report.outcomes.filter((outcome) => !recoveryIds.has(outcome.id)).every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.includes("Native WebDriver")
    && outcome.observedEffect.includes("no Vault ")
    && outcome.observedEffect.includes("credential")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    settingsOpen: boolean;
    vaultWorkspaceOpen: boolean;
    settingsTab: string;
    settingsTabStored: string | null;
    vaultWorkspaceTab: string;
    vaultSetupMode: string;
    vaultSetupRememberDevice: boolean;
    vaultRecoveryKitVisible: boolean;
    vaultRecoveryImport: boolean;
    vaultConfigured: boolean;
    vaultLocked: boolean;
    vaultConfiguredSetupFormVisible: boolean;
    vaultUnlockRememberDevice: boolean;
    vaultRememberedDeviceEnabled: boolean;
    vaultRecoveryCreateCount: number;
    vaultRecoveryConfirmCount: number;
    vaultChangeSetupCount: number;
    vaultLockCount: number;
    vaultUnlockCount: number;
    vaultResetCount: number;
    vaultGrantsRefreshCount: number;
    vaultGrantRevokeCount: number;
    vaultRememberDeviceEnableCount: number;
    vaultForgetDeviceCount: number;
    seededSecretRefs: string[];
    grants: Array<Record<string, unknown>>;
    renderedGrantIds: string[];
    textValues: Record<string, string>;
    choices: Record<string, boolean | string>;
    clickedSelectors: string[];
    forbiddenCredentialClicks: string[];
  };
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.vaultWorkspaceOpen, false);
  assert.equal(audit.settingsTab, "data");
  assert.equal(audit.settingsTabStored, "data");
  assert.equal(audit.vaultWorkspaceTab, "secrets");
  assert.equal(audit.vaultSetupMode, "local");
  assert.equal(audit.vaultSetupRememberDevice, false);
  assert.equal(audit.vaultRecoveryKitVisible, false);
  assert.equal(audit.vaultRecoveryImport, false);
  assert.equal(audit.vaultConfigured, false);
  assert.equal(audit.vaultLocked, false);
  assert.equal(audit.vaultConfiguredSetupFormVisible, false);
  assert.equal(audit.vaultUnlockRememberDevice, true);
  assert.equal(audit.vaultRememberedDeviceEnabled, false);
  assert.equal(audit.vaultRecoveryCreateCount, 13);
  assert.equal(audit.vaultRecoveryConfirmCount, 11);
  assert.equal(audit.vaultChangeSetupCount, 1);
  assert.equal(audit.vaultLockCount, 6);
  assert.equal(audit.vaultUnlockCount, 2);
  assert.equal(audit.vaultResetCount, 30);
  assert.equal(audit.vaultGrantsRefreshCount, 1);
  assert.equal(audit.vaultGrantRevokeCount, 1);
  assert.equal(audit.vaultRememberDeviceEnableCount, 2);
  assert.equal(audit.vaultForgetDeviceCount, 1);
  assert.deepEqual(audit.seededSecretRefs, []);
  assert.deepEqual(audit.grants, []);
  assert.deepEqual(audit.renderedGrantIds, []);
  assert(syntheticGrantValues.every((value) => !JSON.stringify(audit).includes(value)), "audit must not retain synthetic Vault grant values");
  assert.equal(Object.keys(audit.textValues).length, 34);
  assert(Object.values(audit.textValues).every((value) => value === ""));
  assert.deepEqual(audit.choices, baselineChoices);
  assert.deepEqual(audit.forbiddenCredentialClicks, []);
  assert(["visible", "userOnly", "toolUseAlways", "browserFillAlways"].every((level) => (
    audit.clickedSelectors.includes(`[data-debug-id='vault-permission-${level}']`)
  )));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-setup-mode'] > button:first-child"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-setup-mode'] > button:last-child"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-remember-device-setup']"));
  assert(audit.clickedSelectors.includes(".vault-setup-actions > button:first-child"));
  assert(audit.clickedSelectors.includes(".vault-recovery-kit .vault-check-row input"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-recovery-confirm']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-change-setup']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-remember-device-unlock']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='shellx-vault-unlock']"));
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='shellx-vault-remember-device-enable']").length, 2);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='shellx-vault-forget-device']").length, 1);
  assert(audit.clickedSelectors.includes("[data-debug-id='vault-workspace-lock']"));
  assert(audit.clickedSelectors.includes("[data-debug-id='surface-components-vaultpanel-5']"));
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='vault-tab-grants']").length, 2);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === ".vault-grants-panel .vault-panel-head > button.settings-pill").length, 1);
  assert.equal(audit.clickedSelectors.filter((selector) => selector === "[data-debug-id='shellx-vault-grant-row'] > button.settings-pill").length, 1);

  const boundedSurfaceIds = new Set(plan.assignments
    .filter((assignment) => (
      assignment.driverId === "ui-control-bounded-installed"
      && fixtureIds.has(assignment.fixtureId)
    ))
    .map((assignment) => assignment.surfaceId));
  const boundedAssignments = assignments.filter((assignment) => boundedSurfaceIds.has(assignment.surface.id));
  assert.equal(boundedAssignments.length, 58, "all value-blind Vault drafts and bounded grant lifecycles must enter the native lane");
  const boundedRequest: ReleaseSurfaceDriverRequest = {
    ...request,
    driverId: "ui-control-bounded-installed",
    controller: releaseSurfaceControllerBindingFixture("scripts/release-drivers/ui-control-bounded-installed.ts", [
      "scripts/release-drivers/ui-control-installed.ts",
      "scripts/release-drivers/ui-control-bounded-installed-assignments.ts",
      ...UI_CONTROL_INSTALLED_CONTROLLER_FILES,
    ]),
    assignments: boundedAssignments,
  };
  writeFileSync(boundedRequestPath, `${JSON.stringify(boundedRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const boundedRun = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", boundedRequestPath,
    "--out", boundedReportPath,
  ], { cwd: root, encoding: "utf8", timeout: 300_000 });
  const boundedReportText = existsSync(boundedReportPath) ? readFileSync(boundedReportPath, "utf8") : "";
  assert.equal(boundedRun.status, 0, [boundedRun.error?.message, boundedRun.stderr, boundedRun.stdout, boundedReportText].filter(Boolean).join("\n"));
  const boundedReport: ReleaseSurfaceDriverReport = JSON.parse(boundedReportText);
  assert.deepEqual(validateReleaseSurfaceDriverReport(boundedRequest, boundedReport), []);
  assert.equal(boundedReport.outcomes.length, 58);
  assert(boundedReport.outcomes.every((outcome) => (
    outcome.present === "pass" && outcome.invoke === "pass"
    && outcome.effect === "pass" && outcome.cleanup === "pass"
  )), JSON.stringify(boundedReport.outcomes, null, 2));

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(overwrite.error, undefined, overwrite.error?.message);
  assert.notEqual(overwrite.status, 0, "Vault draft evidence output must remain create-only");
  assert.match(
    `${overwrite.stderr}\n${overwrite.stdout}`,
    /EEXIST|(?:file|output) already exists/i,
    "Vault draft overwrite refusal must come from create-only output semantics",
  );

  console.log("Release surface Vault UI controls passed: 58 exact assignments");
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
      throw new Error(`Vault draft fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Vault draft fixture did not publish its ports");
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
