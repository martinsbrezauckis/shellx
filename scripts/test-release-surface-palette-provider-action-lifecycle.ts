import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { executePaletteProviderAction } from "./release-drivers/palette-action-provider-action-installed";
import { providerActionPromptMatches } from "../src/lib/debug-provider-action-fixture";

const root = resolve(import.meta.dirname, "..");
const debugProviderRouteSource = readFileSync(resolve(root, "src-tauri/src/debug_api_providers.rs"), "utf8");
const nativeFixtureSource = readFileSync(resolve(root, "src-tauri/src/main.rs"), "utf8");
for (const action of ["composer-send", "work-preview-palette-ask-fix"]) {
  assert(
    debugProviderRouteSource.includes(`"${action}"`)
      && nativeFixtureSource.includes(`"${action}"`),
    `installed provider fixture must authorize ${action} in both the authenticated route and native fixture process`,
  );
}
const temp = mkdtempSync(join(tmpdir(), "shellx-palette-provider-action-"));
const profileRoot = join(temp, `shellx-final-palette-provider-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-palette-provider-action-token-0001";
const sessionId = "fixture-palette-provider-action-session-0001";
const instanceId = "fixture-palette-provider-action-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const driverId = "palette-action-provider-action-installed";
let fixture: ChildProcess | null = null;

try {
  assert(providerActionPromptMatches(
    "work-preview-palette-ask-fix",
    [
      "Preview Doctor found a problem or the user requested a preview repair pass.",
      "Preview context:",
      "ui-work-preview-start",
      "page title: ShellX release Preview",
      "Fix the issue and verify it visually before saying it is fixed.",
    ].join("\n"),
  ));
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
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
    "--import", "tsx",
    resolve(root, "scripts/release-drivers/palette-action-provider-action-installed.ts"),
    "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    kind: string;
    invocationTransport: string;
    supportedFixtures: string[];
  };
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.kind, "palette-action");
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.deepEqual(manifest.supportedFixtures, ["ui:provider-action-owned-work-preview-palette-ask-fix"]);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const report = await executePaletteProviderAction(request);
  assert.equal(report.outcomes.length, 1);
  assert.deepEqual(
    report.outcomes.map(({ present, invoke, effect, cleanup, error }) => ({ present, invoke, effect, cleanup, error })),
    [{ present: "pass", invoke: "pass", effect: "pass", cleanup: "pass", error: undefined }],
    JSON.stringify(report.outcomes, null, 2),
  );
  assert(report.outcomes[0]?.observedEffect.includes("work-preview-palette-ask-fix"));
  assert(report.outcomes[0]?.observedEffect.includes("no external provider was called"));

  const auditResponse = await fetch(`${candidateBase}/audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    providerActionFixture: string | null;
    providerActionDigest: string | null;
    providerActionRunId: string | null;
    previewStatus: string | null;
    previewUrl: string | null;
    clickedSelectors: string[];
  };
  assert.equal(audit.providerActionFixture, null);
  assert.equal(audit.providerActionDigest, null);
  assert.equal(audit.providerActionRunId, null);
  assert.equal(audit.previewStatus, "stopped");
  assert.equal(audit.previewUrl, null);
  assert(audit.clickedSelectors.includes("[data-palette-action-id='act-preview-doctor']"));
  console.log("Palette Preview Doctor provider lifecycle passed: owned preview, exact prompt receipt, exact cleanup, 0 external provider calls");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const assignment = plan.assignments.find((entry) => entry.surfaceId === "palette-action:act-preview-doctor");
  assert(assignment && assignment.driverId === driverId);
  const surface = inventory.items.find((entry) => entry.id === assignment.surfaceId);
  assert(surface);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "palette-action",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
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
    assignments: [{
      surface,
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }],
  };
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("palette provider fixture exited before startup");
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch { /* create-only state may not exist yet */ }
    await delay(50);
  }
  throw new Error("palette provider fixture did not publish ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
