import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import type { ReleaseSurfaceInventory, ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP,
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE,
  BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES,
  BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP,
  BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE,
  BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE,
  executeBrowserDeveloperEvidenceControls,
  executeBrowserDeveloperEvidenceMarkers,
  supportsBrowserDeveloperEvidenceControl,
  supportsBrowserDeveloperEvidenceMarker,
} from "./release-drivers/ui-browser-developer-evidence-lifecycle";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-browser-developer-evidence-"));
const profileRoot = join(temp, `shellx-final-browser-developer-evidence-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-browser-developer-evidence-token-0001";
const sessionId = "fixture-browser-developer-evidence-session-0001";
const instanceId = "fixture-browser-developer-evidence-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const controlDriverId = "ui-control-browser-developer-evidence-installed";
const markerDriverId = "ui-debug-browser-developer-evidence-installed";
const controlIds = [
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-approve-current-site"]@src/browser/components/BrowserDeveloperInspection.tsx#4',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-disable-mode"]@src/browser/components/BrowserDeveloperInspection.tsx#5',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-har"]@src/browser/components/BrowserDeveloperInspection.tsx#2',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-export-performance"]@src/browser/components/BrowserDeveloperInspection.tsx#3',
  'ui-control:src/browser/components/BrowserDeveloperInspection.tsx:[data-debug-id="shellx-browser-developer-inspect"]@src/browser/components/BrowserDeveloperInspection.tsx#1',
  'ui-control:src/browser/components/BrowserEvidencePanel.tsx:[data-debug-id="shellx-browser-evidence-teach-workflow"]@src/browser/components/BrowserEvidencePanel.tsx#2',
] as const;
const markerIds = [
  "ui-debug-surface:shellx-browser-evidence-teach-workflow@src/browser/components/BrowserEvidencePanel.tsx#3",
  "ui-debug-surface:shellx-browser-developer-*-receipt@src/browser/components/BrowserDeveloperInspection.tsx#1",
  "ui-debug-surface:shellx-browser-developer-access-active@src/browser/components/BrowserDeveloperInspection.tsx#18",
  "ui-debug-surface:shellx-browser-developer-access-required@src/browser/components/BrowserDeveloperInspection.tsx#16",
  "ui-debug-surface:shellx-browser-developer-approve-current-site@src/browser/components/BrowserDeveloperInspection.tsx#17",
  "ui-debug-surface:shellx-browser-developer-artifacts@src/browser/components/BrowserDeveloperInspection.tsx#20",
  "ui-debug-surface:shellx-browser-developer-clean@src/browser/components/BrowserDeveloperInspection.tsx#9",
  "ui-debug-surface:shellx-browser-developer-console-summary@src/browser/components/BrowserDeveloperInspection.tsx#5",
  "ui-debug-surface:shellx-browser-developer-disable-mode@src/browser/components/BrowserDeveloperInspection.tsx#19",
  "ui-debug-surface:shellx-browser-developer-export-har@src/browser/components/BrowserDeveloperInspection.tsx#13",
  "ui-debug-surface:shellx-browser-developer-export-performance@src/browser/components/BrowserDeveloperInspection.tsx#14",
  "ui-debug-surface:shellx-browser-developer-inspect@src/browser/components/BrowserDeveloperInspection.tsx#12",
  "ui-debug-surface:shellx-browser-developer-inspection@src/browser/components/BrowserDeveloperInspection.tsx#11",
  "ui-debug-surface:shellx-browser-developer-issues@src/browser/components/BrowserDeveloperInspection.tsx#8",
  "ui-debug-surface:shellx-browser-developer-last-inspected@src/browser/components/BrowserDeveloperInspection.tsx#3",
  "ui-debug-surface:shellx-browser-developer-network-summary@src/browser/components/BrowserDeveloperInspection.tsx#6",
  "ui-debug-surface:shellx-browser-developer-page-summary@src/browser/components/BrowserDeveloperInspection.tsx#4",
  "ui-debug-surface:shellx-browser-developer-partial@src/browser/components/BrowserDeveloperInspection.tsx#10",
  "ui-debug-surface:shellx-browser-developer-performance-summary@src/browser/components/BrowserDeveloperInspection.tsx#7",
  "ui-debug-surface:shellx-browser-developer-state-*@src/browser/components/BrowserDeveloperInspection.tsx#15",
  "ui-debug-surface:shellx-browser-developer-summary@src/browser/components/BrowserDeveloperInspection.tsx#2",
] as const;

let fixture: ChildProcess | null = null;
try {
  const component = readFileSync(resolve(root, "src/browser/components/BrowserDeveloperInspection.tsx"), "utf8");
  const hook = readFileSync(resolve(root, "src/browser/hooks/useBrowserDeveloperInspection.ts"), "utf8");
  const panel = readFileSync(resolve(root, "src/browser/components/BrowserEvidencePanel.tsx"), "utf8");
  const generator = readFileSync(resolve(root, "scripts/generate-release-surface-driver-plan.ts"), "utf8");
  const lifecycle = readFileSync(resolve(root, "scripts/release-drivers/ui-browser-developer-evidence-lifecycle.ts"), "utf8");
  const currentPlan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as {
    assignments: Array<{
      surfaceId: string;
      driverId: string;
      fixtureId: string;
      oracleId: string;
      cleanupId: string;
    }>;
  };
  assert(component.includes("isTrustedShellxUserEvent(event)") && component.includes("receipt identity, bytes, and hash prefix only"));
  assert(hook.includes("approveBrowserDeveloperModeHostForOperator")
    && hook.includes("disableBrowserDeveloperModeForOperator")
    && hook.includes("exportBrowserHarForOperator")
    && hook.includes("exportBrowserPerformanceForOperator"));
  assert(panel.includes("teachSource.kind === \"ready\"") && panel.includes("BrowserDeveloperInspection activeTaskId={activeTaskId}"));
  assert(generator.includes("BROWSER_DEVELOPER_EVIDENCE_UI_SURFACE_IDS")
    && generator.includes("BROWSER_DEVELOPER_EVIDENCE_DEBUG_SURFACE_IDS")
    && generator.includes(controlDriverId)
    && generator.includes(markerDriverId));
  assert(lifecycle.includes('"GET", "/browser/state"'), "installed driver must read the shipped bounded Browser state route");
  assert(lifecycle.includes('expectedDomains: ["127.0.0.1"]'), "installed driver must scope its owned private loopback target");
  assert(!lifecycle.includes('"GET", "/audit"'), "installed driver must not depend on the fixture-only audit route");
  const requestedIds = [...controlIds, ...markerIds].sort();
  const promotedAssignments = currentPlan.assignments
    .filter((assignment) => requestedIds.includes(assignment.surfaceId as typeof requestedIds[number]));
  assert.equal(promotedAssignments.length, requestedIds.length, "all 27 exact Developer/Evidence surfaces must have one assignment");
  assert.deepEqual(promotedAssignments.map((assignment) => assignment.surfaceId).sort(), requestedIds);
  for (const assignment of promotedAssignments) {
    const isControl = controlIds.includes(assignment.surfaceId as typeof controlIds[number]);
    assert.equal(assignment.driverId, isControl ? controlDriverId : markerDriverId);
    assert.equal(assignment.fixtureId, isControl
      ? BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE
      : BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE);
    assert.equal(assignment.cleanupId, isControl
      ? BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP
      : BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP);
    if (isControl) {
      assert(BROWSER_DEVELOPER_EVIDENCE_CONTROL_ORACLES.includes(assignment.oracleId as never));
    } else {
      assert.equal(assignment.oracleId, BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE);
    }
  }
  assert(requestedIds.every((id) => generator.includes(id)), "generator source must map every exact requested Browser Developer/Evidence surface ID");

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
  const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const controls = controlIds.map((id) => controlAssignment(requiredSurface(surfaceById, id)));
  const markers = markerIds.map((id) => markerAssignment(requiredSurface(surfaceById, id)));
  assert.equal(controls.length + markers.length, 27);
  assert(controls.every(supportsBrowserDeveloperEvidenceControl));
  assert(markers.every(supportsBrowserDeveloperEvidenceMarker));

  for (const [entrypoint, driverId, kind, fixtures, cleanups, oracles] of [
    ["scripts/release-drivers/ui-control-browser-developer-evidence-installed.ts", controlDriverId, "ui-control", [BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE], [BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP], ["ui:activation:browser-evidence-teach-owned-draft", "ui:activation:browser-developer-inspection-denied", "ui:activation:browser-developer-site-approved", "ui:activation:browser-developer-mode-disabled", "ui:activation:browser-developer-artifact-receipt"]],
    ["scripts/release-drivers/ui-debug-browser-developer-evidence-installed.ts", markerDriverId, "ui-debug-surface", [BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE], [BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP], [BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE]],
  ] as const) {
    const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], { cwd: root, encoding: "utf8" });
    assert.equal(described.status, 0, described.stderr || described.stdout);
    const manifest = JSON.parse(described.stdout) as { id: string; kind: string; invocationTransport: string; supportedFixtures: string[]; supportedCleanups: string[]; supportedOracles: string[] };
    assert.equal(manifest.id, driverId);
    assert.equal(manifest.kind, kind);
    assert.equal(manifest.invocationTransport, "native-installed-input");
    assert.deepEqual(manifest.supportedFixtures, fixtures);
    assert.deepEqual(manifest.supportedCleanups, cleanups);
    assert.deepEqual(manifest.supportedOracles, oracles);
  }

  const controlReport = await executeBrowserDeveloperEvidenceControls(createRequest(
    controlDriverId,
    "ui-control",
    controls,
    candidateBase,
    webdriverBase,
    ports.candidatePort,
  ));
  const markerReport = await executeBrowserDeveloperEvidenceMarkers(createRequest(
    markerDriverId,
    "ui-debug-surface",
    markers,
    candidateBase,
    webdriverBase,
    ports.candidatePort,
  ));
  for (const report of [controlReport, markerReport]) {
    assert(report.outcomes.every((outcome) => (
      outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass" && !outcome.error
    )), JSON.stringify(report.outcomes, null, 2));
  }
  assert.equal(controlReport.outcomes.length, 6);
  assert.equal(markerReport.outcomes.length, 21);
  assert(controlReport.outcomes.some((outcome) => outcome.id.includes("teach-workflow") && outcome.observedEffect.includes("no approval or replay authority")));
  assert(controlReport.outcomes.filter((outcome) => outcome.id.includes("export-")).every((outcome) => (
    !outcome.observedEffect.includes("/tmp/") && !outcome.observedEffect.includes("file://")
  )));

  const auditResponse = await fetch(`${candidateBase}/audit`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as Record<string, unknown>;
  assert.equal(audit.activeTaskId, null);
  assert.equal(audit.browserTaskTabId, null);
  assert.equal(audit.activeTaskStatus, "aborted");
  assert.equal(audit.browserDeveloperState, "idle");
  assert.equal(audit.browserDeveloperModeEnabled, false);
  assert.equal(audit.browserDeveloperSiteApproved, false);
  assert.deepEqual(audit.browserDeveloperArtifacts, {});
  assert.equal(audit.browserTeachDraftId, null);
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  console.log("Browser Developer/Evidence installed driver tests passed (27 exact controls/markers; pending-denied-active-partial-clean, compact artifacts, Teach draft, and exact cleanup)");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function controlAssignment(surface: ReleaseSurfaceItem): ReleaseSurfaceDriverRequest["assignments"][number] {
  const name = surface.name;
  const oracleId = name.includes("teach-workflow")
    ? "ui:activation:browser-evidence-teach-owned-draft"
    : name.includes("developer-inspect")
      ? "ui:activation:browser-developer-inspection-denied"
      : name.includes("approve-current-site")
        ? "ui:activation:browser-developer-site-approved"
        : name.includes("disable-mode")
          ? "ui:activation:browser-developer-mode-disabled"
          : "ui:activation:browser-developer-artifact-receipt";
  return {
    surface,
    fixtureId: BROWSER_DEVELOPER_EVIDENCE_CONTROL_FIXTURE,
    expectedEffect: `Fixture control ${name}`,
    oracleId,
    cleanupId: BROWSER_DEVELOPER_EVIDENCE_CONTROL_CLEANUP,
  };
}

function markerAssignment(surface: ReleaseSurfaceItem): ReleaseSurfaceDriverRequest["assignments"][number] {
  return {
    surface,
    fixtureId: BROWSER_DEVELOPER_EVIDENCE_DEBUG_FIXTURE,
    expectedEffect: `Fixture marker ${surface.name}`,
    oracleId: BROWSER_DEVELOPER_EVIDENCE_DEBUG_ORACLE,
    cleanupId: BROWSER_DEVELOPER_EVIDENCE_DEBUG_CLEANUP,
  };
}

function createRequest(
  driverId: string,
  driverKind: "ui-control" | "ui-debug-surface",
  assignments: ReleaseSurfaceDriverRequest["assignments"],
  candidateBase: string,
  webdriverBase: string,
  candidatePort: number,
): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind,
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "b".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "c".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "d".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: candidatePort,
        imagePath: "/tmp/fixture/shellx",
        imageSha256: "c".repeat(64),
      }),
    },
    nativeWebDriver: {
      base: webdriverBase,
      sessionId,
      evidence: { basename: "native-webdriver-binding.json", sha256: "e".repeat(64), bytes: 1024 },
    },
    assignments,
  };
}

function requiredSurface(surfaceById: Map<string, ReleaseSurfaceItem>, id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  if (!surface) throw new Error(`missing exact Browser Developer/Evidence inventory surface ${id}`);
  return surface;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Browser Developer/Evidence fixture exited before startup: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) {
        return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
      }
    } catch { /* fixture publishes atomically after both servers listen */ }
    await delay(25);
  }
  throw new Error("Browser Developer/Evidence fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
