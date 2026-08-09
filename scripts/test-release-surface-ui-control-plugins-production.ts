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
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-plugins-production-"));
const profileRoot = join(temp, "shellx-final-webdriver-0123456789abcdef");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-plugins-production-token-0001";
const sessionId = "fixture-ui-plugins-production-session-0001";
const instanceId = "shellx-final-0123456789abcdef";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const fixtureId = "ui:plugins-owned-production-profile";
const driverId = "ui-control-plugins-production-installed";
const syntheticValue = "SHELLX_RELEASE_PLUGIN_SYNTHETIC_VAULT_VALUE";
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === driverId && assignment.fixtureId === fixtureId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Plugins production assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 6);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 6);
  assert(plan.assignments.every((assignment) => !(
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.surfaceId.includes("src/components/PluginsModal.tsx")
  )), "all PluginsModal controls must have executable assignments");

  const guardSource = readFileSync(join(root, "src-tauri/src/debug_api_session_state.rs"), "utf8");
  assert(guardSource.includes("plugins_production_fixture_not_isolated"));
  assert(guardSource.includes("SHELLX_MCP_MARKETPLACE_E2E"));
  assert(guardSource.includes("SHELLX_VAULT_PROFILE_DIR"));
  const modalSource = readFileSync(join(root, "src/components/PluginsModal.tsx"), "utf8");
  for (const command of [
    "mcp_marketplace_install",
    "mcp_marketplace_uninstall",
    "mcp_marketplace_set_enabled",
    "vault_set",
  ]) assert(modalSource.includes(command), `production Plugins fixture must retain ${command}`);

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
    "--plugins-production-lifecycle",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const entrypoint = "scripts/release-drivers/ui-control-plugins-production-installed.ts";
  const controllerFiles = [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/release-drivers/ui-control-plugins-production.ts",
  ];
  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.deepEqual(manifest.supportedFixtures, [fixtureId]);
  assert.deepEqual(manifest.supportedCleanups, [
    "ui:restore-owned-plugin-config-delete-synthetic-vault-key-and-close-modal",
  ]);
  for (const oracle of [
    "ui:activation:plugins-recommended-installed",
    "ui:boolean-state-transition",
    "ui:activation:plugins-entry-installed",
    "ui:activation:plugins-vault-key-saved",
    "ui:activation:plugins-entry-removed",
  ]) assert(manifest.supportedOracles.includes(oracle));

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: fixturePlatform,
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(entrypoint, controllerFiles),
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
    "--import", "tsx", resolve(root, entrypoint), "--request", requestPath, "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const reportText = readFileSync(reportPath, "utf8");
  assert(!reportText.includes(syntheticValue), "driver evidence must never contain synthetic Vault material");
  const report = JSON.parse(reportText) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 6);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && !outcome.error
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  assert.equal(existsSync(join(shellxHome, "mcp-marketplace.json")), false, "marketplace state must restore absence");
  assert.equal(existsSync(join(profileRoot, ".grok", "config.toml")), false, "managed MCP config must restore absence");
  const vaultResponse = await fetch(`${candidateBase}/vault/keys`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(vaultResponse.status, 200);
  assert.deepEqual(await vaultResponse.json(), { keys: [], entries: [] });
  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const auditText = await auditResponse.text();
  assert(!auditText.includes(syntheticValue), "fixture audit must never expose synthetic Vault material");
  const audit = JSON.parse(auditText) as {
    pluginsOpen: boolean;
    pluginsFixtureActive: boolean;
    pluginsProductionFixtureActive: boolean;
    pluginsKeyFormEntryId: string | null;
    pluginsKeyDraftValue: string;
    pluginsVaultKeys: string[];
    clickedSelectors: string[];
  };
  assert.equal(audit.pluginsOpen, false);
  assert.equal(audit.pluginsFixtureActive, false);
  assert.equal(audit.pluginsProductionFixtureActive, false);
  assert.equal(audit.pluginsKeyFormEntryId, null);
  assert.equal(audit.pluginsKeyDraftValue, "");
  assert.deepEqual(audit.pluginsVaultKeys, []);
  for (const selectorFragment of [
    ".mp-hero button.mp-action-btn-primary",
    "plugins-entry-toggle",
    "surface-components-pluginsmodal-10",
    "surface-components-pluginsmodal-11",
    "surface-components-pluginsmodal-13",
    "button.mp-action-btn-secondary",
  ]) assert(audit.clickedSelectors.some((selector) => selector.includes(selectorFragment)));

  console.log("Plugins production lifecycle passed: 6 native controls, exact marketplace/Vault transitions, exact cleanup, redacted evidence");
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
      throw new Error(`Plugins production fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Plugins production fixture did not publish its ports");
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
