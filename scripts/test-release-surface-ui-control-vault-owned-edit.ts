import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseSurfaceFixtureSourceCommit } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  VAULT_OWNED_EDIT_CLEANUPS,
  VAULT_OWNED_EDIT_FIXTURES,
  VAULT_OWNED_EDIT_ORACLES,
  VAULT_OWNED_EDIT_SURFACE_IDS,
  VAULT_OWNED_REVEAL_MARKER_CLEANUP,
  VAULT_OWNED_REVEAL_MARKER_FIXTURE,
  VAULT_OWNED_REVEAL_MARKER_ORACLE,
  VAULT_OWNED_REVEAL_MARKER_SURFACE_ID,
  exerciseOwnedVaultEditControl,
  exerciseOwnedVaultRevealMarker,
} from "./release-drivers/ui-control-vault-owned-edit";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-vault-owned-edit-"));
const profileRoot = join(temp, `shellx-final-vault-owned-edit-${"c".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-vault-owned-edit-token-0001";
const sessionId = "fixture-vault-owned-edit-session-0001";
const instanceId = "fixture-vault-owned-edit-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const entrypoint = "scripts/release-drivers/ui-control-vault-owned-edit-installed.ts";
const revealMarkerEntrypoint = "scripts/release-drivers/ui-debug-vault-row-reveal-installed.ts";
const controllerFiles = [
  "scripts/lib/release-surface-installed-input-client.ts",
  "scripts/lib/release-surface-bounded-observation.ts",
  "scripts/lib/release-surface-macos-native-input.ts",
  "scripts/release-drivers/ui-control-vault-owned-edit.ts",
];
const newVaultLifecyclePromotedIds = [
  'ui-control:src/components/settings/VaultTab.tsx:[aria-label^="Confirm delete "]@src/components/settings/VaultTab.tsx#12',
  'ui-control:src/components/settings/VaultTab.tsx::is([aria-label="Hide generated secret value"],[aria-label="Reveal generated secret value"])@src/components/settings/VaultTab.tsx#25',
  'ui-control:src/components/settings/VaultTab.tsx:[data-debug-id="vault-generate-password"]@src/components/settings/VaultTab.tsx#26',
  'ui-control:src/components/settings/VaultTab.tsx:[data-debug-id="surface-components-settings-vaulttab-30"]@src/components/settings/VaultTab.tsx#30',
  'ui-control:src/components/settings/VaultTab.tsx:role=button;name="Save profile card"@src/components/settings/VaultTab.tsx#46',
  'ui-control:src/components/settings/VaultTab.tsx:role=button;name="Save wallet"@src/components/settings/VaultTab.tsx#60',
  'ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-regenerate"]@src/components/VaultPasswordGenerator.tsx#7',
  'ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-use"]@src/components/VaultPasswordGenerator.tsx#8',
  'ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-save"]@src/components/VaultPasswordGenerator.tsx#9',
  'ui-control:src/components/VaultPasswordGenerator.tsx:role=button;name="Replace"@src/components/VaultPasswordGenerator.tsx#10',
] as const;
const newVaultClipboardPromotedIds = [
  'ui-control:src/components/settings/VaultTab.tsx:[aria-label^="Copy value for "]@src/components/settings/VaultTab.tsx#8',
] as const;

let fixture: ChildProcess | null = null;
try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-ui-control-vault-owned-edit-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token-file", tokenPath,
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
  assert.equal(manifest.id, "ui-control-vault-owned-edit-installed");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, [...VAULT_OWNED_EDIT_FIXTURES]);
  assert.deepEqual(manifest.supportedCleanups, [...VAULT_OWNED_EDIT_CLEANUPS]);
  assert.deepEqual(manifest.supportedOracles, [...VAULT_OWNED_EDIT_ORACLES]);
  assert.deepEqual(manifest.controllerFiles, controllerFiles);
  const describedRevealMarker = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, revealMarkerEntrypoint), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(describedRevealMarker.status, 0, describedRevealMarker.stderr || describedRevealMarker.stdout);
  const revealMarkerManifest = JSON.parse(describedRevealMarker.stdout) as {
    id?: string;
    kind?: string;
    invocationTransport?: string;
    supportedFixtures?: string[];
    supportedCleanups?: string[];
    supportedOracles?: string[];
    controllerFiles?: string[];
  };
  assert.equal(revealMarkerManifest.id, "ui-debug-vault-row-reveal-installed");
  assert.equal(revealMarkerManifest.kind, "ui-debug-surface");
  assert.equal(revealMarkerManifest.invocationTransport, "native-installed-input");
  assert.deepEqual(revealMarkerManifest.supportedFixtures, [VAULT_OWNED_REVEAL_MARKER_FIXTURE]);
  assert.deepEqual(revealMarkerManifest.supportedCleanups, [VAULT_OWNED_REVEAL_MARKER_CLEANUP]);
  assert.deepEqual(revealMarkerManifest.supportedOracles, [VAULT_OWNED_REVEAL_MARKER_ORACLE]);
  assert.deepEqual(revealMarkerManifest.controllerFiles, controllerFiles);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseOwnedVaultEditControl({ base: candidateBase, token }, input, assignment));
  }
  assert.equal(outcomes.length, 26);
  assert(outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(outcomes, null, 2));
  const revealMarkerAssignment = releasePlanAssignment(VAULT_OWNED_REVEAL_MARKER_SURFACE_ID);
  const revealMarkerOutcome = await exerciseOwnedVaultRevealMarker(
    { base: candidateBase, token },
    input,
    {
      surface: requiredSurfaceFromInventory(VAULT_OWNED_REVEAL_MARKER_SURFACE_ID),
      fixtureId: revealMarkerAssignment.fixtureId,
      expectedEffect: revealMarkerAssignment.expectedEffect,
      oracleId: revealMarkerAssignment.oracleId,
      cleanupId: revealMarkerAssignment.cleanupId,
    },
  );
  assert.equal(revealMarkerAssignment.driverId, "ui-debug-vault-row-reveal-installed");
  assert.equal(revealMarkerAssignment.fixtureId, VAULT_OWNED_REVEAL_MARKER_FIXTURE);
  assert.equal(revealMarkerAssignment.oracleId, VAULT_OWNED_REVEAL_MARKER_ORACLE);
  assert.equal(revealMarkerAssignment.cleanupId, VAULT_OWNED_REVEAL_MARKER_CLEANUP);
  assert.deepEqual(
    [revealMarkerOutcome.present, revealMarkerOutcome.invoke, revealMarkerOutcome.effect, revealMarkerOutcome.cleanup],
    ["pass", "pass", "pass", "pass"],
    JSON.stringify(revealMarkerOutcome, null, 2),
  );
  assert(!JSON.stringify(revealMarkerOutcome).includes("SHELLX_RELEASE_UI_"));
  const outcomeText = JSON.stringify(outcomes);
  assert(!outcomeText.includes("SHELLX_RELEASE_UI_"));
  assert(!outcomeText.includes("fixture-generated-"));

  const auditResponse = await fetch(`${candidateBase}/audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(auditResponse.status, 200);
  const auditText = await auditResponse.text();
  assert(!auditText.includes("SHELLX_RELEASE_UI_"));
  assert(!auditText.includes("fixture-generated-"));
  const audit = JSON.parse(auditText) as {
    settingsOpen: boolean;
    settingsTab: string;
    ownedKeyPresent: boolean;
    redactedDirectory: Array<Record<string, unknown>>;
    renderedOwnedKey: boolean;
    revealedOpen: boolean;
    replacing: boolean;
    editingMetadata: boolean;
    replacementDraftPresent: boolean;
    metadataDescriptionDraft: string;
    metadataUserOnlyDraft: boolean;
    newDescriptionDraft: string;
    newUserOnlyDraft: boolean;
    newKeyDraft: string;
    newValueDraftPresent: boolean;
    newValueVisible: boolean;
    resourceFormTab: string;
    generatorOpen: boolean;
    generatorRevealed: boolean;
    generatorGenerationCount: number;
    generatorUseCount: number;
    generatorSaveCount: number;
    generatorDeleteCount: number;
    profileLabelDraft: string;
    walletLabelDraft: string;
    ownedDeleteArmed: boolean;
    ownedDeleteCount: number;
    ownedResourceSaveCount: number;
    noticeVisible: boolean;
    refreshTransitions: number;
    revealTransitions: number;
    replacementSaves: number;
    metadataSaves: number;
    secretExposureCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.settingsOpen, false);
  assert.equal(audit.settingsTab, "general");
  assert.equal(audit.ownedKeyPresent, false);
  assert.deepEqual(audit.redactedDirectory, [{
    key: "fixture/baseline",
    description: "Fixture baseline entry",
    userOnly: true,
  }]);
  assert.equal(audit.renderedOwnedKey, false);
  assert.equal(audit.revealedOpen, false);
  assert.equal(audit.replacing, false);
  assert.equal(audit.editingMetadata, false);
  assert.equal(audit.replacementDraftPresent, false);
  assert.equal(audit.metadataDescriptionDraft, "");
  assert.equal(audit.metadataUserOnlyDraft, false);
  assert.equal(audit.newDescriptionDraft, "");
  assert.equal(audit.newUserOnlyDraft, false);
  assert.equal(audit.newKeyDraft, "");
  assert.equal(audit.newValueDraftPresent, false);
  assert.equal(audit.newValueVisible, false);
  assert.equal(audit.resourceFormTab, "secret");
  assert.equal(audit.generatorOpen, false);
  assert.equal(audit.generatorRevealed, false);
  assert.equal(audit.generatorGenerationCount, 2);
  assert.equal(audit.generatorUseCount, 1);
  assert.equal(audit.generatorSaveCount, 1);
  assert.equal(audit.generatorDeleteCount, 1);
  assert.equal(audit.profileLabelDraft, "");
  assert.equal(audit.walletLabelDraft, "");
  assert.equal(audit.ownedDeleteArmed, false);
  assert.equal(audit.ownedDeleteCount, 1);
  assert.equal(audit.ownedResourceSaveCount, 4);
  assert.equal(audit.noticeVisible, false);
  assert.equal(audit.refreshTransitions, 1);
  assert.equal(audit.revealTransitions, 6);
  assert.equal(audit.replacementSaves, 1);
  assert.equal(audit.metadataSaves, 1);
  assert.equal(audit.secretExposureCount, 0);
  assert(audit.clickedSelectors.length > 26);

  console.log("Release surface native owned-Vault edit tests passed (26 controls; zero secret observations)");
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
  const promotedAssignments = newVaultLifecyclePromotedIds.map((surfaceId) => {
    const assignment = plan.assignments.find((candidate) => candidate.surfaceId === surfaceId);
    assert(assignment, `new Vault lifecycle assignment is missing ${surfaceId}`);
    return assignment;
  });
  assert(promotedAssignments.every((assignment) => assignment.driverId === "ui-control-vault-owned-edit-installed"));
  assert(promotedAssignments.every((assignment) => assignment.cleanupId
    === "ui:delete-exact-owned-vault-resources-clear-sensitive-drafts-and-restore-settings"));
  assert(promotedAssignments.every((assignment) => VAULT_OWNED_EDIT_SURFACE_IDS.has(assignment.surfaceId)));
  const clipboardAssignments = newVaultClipboardPromotedIds.map((surfaceId) => {
    const assignment = plan.assignments.find((candidate) => candidate.surfaceId === surfaceId);
    assert(assignment, `clipboard Vault lifecycle assignment is missing ${surfaceId}`);
    return assignment;
  });
  assert(clipboardAssignments.every((assignment) => assignment.driverId === "ui-control-clipboard-lifecycle-installed"));
  assert(clipboardAssignments.every((assignment) => assignment.fixtureId === "ui:owned-native-clipboard-empty-lifecycle"));
  assert.equal(new Set([...newVaultLifecyclePromotedIds, ...newVaultClipboardPromotedIds, VAULT_OWNED_REVEAL_MARKER_SURFACE_ID]).size, 12);
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-vault-owned-edit-installed")
    .map((assignment) => ({
      surface: requiredSurface(surfaceById, assignment.surfaceId),
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }));
  assert.equal(assignments.length, 26);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-vault-owned-edit-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
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

function requiredSurfaceFromInventory(id: string): ReleaseSurfaceItem {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as {
    items: ReleaseSurfaceItem[];
  };
  return requiredSurface(new Map(inventory.items.map((surface) => [surface.id, surface])), id);
}

function releasePlanAssignment(id: string): {
  driverId: string;
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
} {
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
  const assignment = plan.assignments.find((candidate) => candidate.surfaceId === id);
  assert(assignment, `release plan is missing ${id}`);
  return assignment;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`owned-Vault fixture exited before startup (${String(child.exitCode)}/${String(child.signalCode)}): ${[
        await streamText(child.stderr),
        await streamText(child.stdout),
      ].filter(Boolean).join("\n")}`);
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
  throw new Error("owned-Vault fixture did not publish its ports");
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
