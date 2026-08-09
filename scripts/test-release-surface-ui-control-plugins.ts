import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceBoundedUiControlControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-plugins-"));
const profileRoot = join(temp, "profile");
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-ui-control-plugins-token-0001";
const sessionId = "fixture-ui-plugins-session-0001";
const instanceId = "fixture-ui-plugins-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixtureId = "ui:plugins-owned-local-draft";
const productionSurfaceIds = [
  "ui-control:src/components/PluginsModal.tsx:[data-debug-id=\"plugins-entry-toggle\"]@src/components/PluginsModal.tsx#7",
  "ui-control:src/components/PluginsModal.tsx:[data-debug-id=\"surface-components-pluginsmodal-10\"]@src/components/PluginsModal.tsx#10",
  "ui-control:src/components/PluginsModal.tsx:[data-debug-id=\"surface-components-pluginsmodal-11\"]@src/components/PluginsModal.tsx#11",
  "ui-control:src/components/PluginsModal.tsx:[data-debug-id=\"surface-components-pluginsmodal-13\"]@src/components/PluginsModal.tsx#13",
  "ui-control:src/components/PluginsModal.tsx:role=button;name=\"Enable Recommended\"@src/components/PluginsModal.tsx#4",
  "ui-control:src/components/PluginsModal.tsx:role=button;name=\"Remove\"@src/components/PluginsModal.tsx#8",
].sort();
let fixture: ChildProcess | null = null;

try {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments
    .filter((assignment) => assignment.driverId === "ui-control-bounded-installed" && assignment.fixtureId === fixtureId)
    .map((assignment) => {
      const surface = inventoryById.get(assignment.surfaceId);
      assert(surface, `Plugins assignment ${assignment.surfaceId} must exist in the exact inventory`);
      return {
        surface,
        fixtureId: assignment.fixtureId,
        expectedEffect: assignment.expectedEffect,
        oracleId: assignment.oracleId,
        cleanupId: assignment.cleanupId,
      };
    });
  assert.equal(assignments.length, 3);
  assert.equal(new Set(assignments.map((assignment) => assignment.surface.id)).size, 3);

  const production = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-plugins-production-installed"
  ));
  assert.deepEqual(production.map((assignment) => assignment.surfaceId).sort(), productionSurfaceIds);
  assert(production.every((assignment) => (
    assignment.fixtureId === "ui:plugins-owned-production-profile"
    && !assignment.expectedEffect.startsWith("BUILDING:")
    && assignment.cleanupId === "ui:restore-owned-plugin-config-delete-synthetic-vault-key-and-close-modal"
  )));

  const blocked = plan.assignments.filter((assignment) => (
    assignment.driverId === "ui-control-backlog-installed"
    && assignment.surfaceId.includes("src/components/PluginsModal.tsx")
  ));
  assert.deepEqual(blocked, []);

  const modalSource = readFileSync(join(root, "src/components/PluginsModal.tsx"), "utf8");
  const appSource = readFileSync(join(root, "src/App.tsx"), "utf8");
  for (const entryId of [
    "release-owned-recommended",
    "release-owned-installed-key",
    "release-owned-uninstalled-key",
  ]) {
    assert(modalSource.includes(`id: "${entryId}"`), `owned fixture must include ${entryId}`);
  }
  assert(modalSource.includes('if (debugFixture === "owned-safe") return;'), "owned fixture must suppress marketplace discovery");
  assert(modalSource.includes('debugFixture === "owned-production"'), "production fixture must retain a separately gated real marketplace path");
  assert(modalSource.includes("OWNED_PRODUCTION_MARKETPLACE_IDS.has(entry.id)"), "production fixture must filter the immutable catalog to fixed offline rows");
  assert(modalSource.includes("if (debugFixture) return;"), "owned fixture must suppress Vault writes");
  assert(modalSource.includes('disabled={mpLoading || debugFixture === "owned-safe"}'), "owned fixture must disable Enable Recommended");
  assert(modalSource.includes("disabled={pending || debugFixture}"), "owned fixture must disable plugin mutations");
  assert(modalSource.includes('disabled={debugFixture || !values[k] || saving === k}'), "owned fixture must disable Save");
  assert(modalSource.includes('e.key === "Enter" && !debugFixture'), "owned fixture must suppress Enter-to-save");
  assert(!modalSource.includes('data-shellx-release-observe="value"'), "password draft values must never enter bounded observation evidence");
  assert(appSource.includes('p.debugPluginsFixture === "owned-safe"'));
  assert(appSource.includes('p.debugPluginsFixture === "owned-production"'));
  assert(appSource.includes('p.debugPluginsFixture === "clear"'));

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
  assert(manifest.supportedCleanups.includes("ui:clear-owned-plugin-draft-and-fixture"));
  assert(manifest.supportedOracles.includes("ui:disclosure-state-transition"));
  assert(manifest.supportedOracles.includes("ui:value-state-transition"));

  const request: ReleaseSurfaceDriverRequest = {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "ui-control-bounded-installed",
    driverKind: "ui-control",
    platform: "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceBoundedUiControlControllerBindingFixture(),
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
    assignments,
  };
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const failures = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport).outcomes.filter((outcome) => outcome.error)
    : null;
  assert.equal(run.status, 0, failures ? JSON.stringify(failures, null, 2) : run.stderr || run.stdout);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, 3);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
    && outcome.observedEffect.startsWith("Native installed input")
  )), JSON.stringify(report.outcomes.filter((outcome) => outcome.error), null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    pluginsOpen: boolean;
    pluginsFixtureActive: boolean;
    pluginsKeyFormEntryId: string | null;
    pluginsKeyDraftValue: string;
    pluginsUnsafeMutationCount: number;
    clickedSelectors: string[];
  };
  assert.equal(audit.pluginsOpen, false);
  assert.equal(audit.pluginsFixtureActive, false);
  assert.equal(audit.pluginsKeyFormEntryId, null);
  assert.equal(audit.pluginsKeyDraftValue, "");
  assert.equal(audit.pluginsUnsafeMutationCount, 0);
  assert(audit.clickedSelectors.every((selector) => (
    selector.includes("release-owned-installed-key")
    || selector.includes("release-owned-uninstalled-key")
  )), "focused Plugins lifecycle must not invoke install, remove, enable, toggle, Save, clipboard, or provider controls");

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/ui-control-bounded-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(overwrite.status, 0, "Plugins evidence output must remain create-only");
  console.log("Plugins native WebDriver lifecycle passed: 3 inert draft controls plus 6 isolated production controls, zero Plugins backlog");
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
      throw new Error(`Plugins fixture exited before startup: ${await streamText(child.stderr)}`);
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
  throw new Error("Plugins fixture did not publish its ports");
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
