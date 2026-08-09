import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { createReleaseSurfaceInstalledInputSession } from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { exerciseOwnedBrowserTabControl } from "./ui-control-owned-browser-bookmarks";

const FIXTURE_ID = "ui:browser-owned-tab-delegation-marker";
const CLEANUP_ID = "ui:delete-owned-browser-tabs-restore-home-active-tab-and-window";
const ORACLE_ID = "ui:activation:owned-browser-tab-delegation-marker";
const markerTargets = new Map<string, { name: string; selector: string; label: string }>([
  [
    "ui-debug-surface:shellx-browser-handoff-tab@src/browser/components/BrowserChrome.tsx#8",
    {
      name: 'src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-handoff-tab"]',
      selector: '[data-debug-id="shellx-browser-handoff-tab"]',
      label: "handoff",
    },
  ],
  [
    "ui-debug-surface:shellx-browser-take-back-tab@src/browser/components/BrowserChrome.tsx#9",
    {
      name: 'src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-take-back-tab"]',
      selector: '[data-debug-id="shellx-browser-take-back-tab"]',
      label: "take-back",
    },
  ],
]);

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-browser-delegation-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts",
    "scripts/release-drivers/ui-debug-browser-delegation-installed.ts",
  ],
  supportedFixtures: [FIXTURE_ID],
  supportedCleanups: [CLEANUP_ID],
  supportedOracles: [ORACLE_ID],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    const target = markerTargets.get(assignment.surface.id);
    if (!target) throw new Error(`Browser delegation marker driver does not support ${assignment.surface.id}`);
    if (assignment.fixtureId !== FIXTURE_ID || assignment.cleanupId !== CLEANUP_ID || assignment.oracleId !== ORACLE_ID) {
      throw new Error(`Browser delegation marker ${assignment.surface.id} omitted its exact fixture contract`);
    }
    const outcome = await exerciseOwnedBrowserTabControl(connection, installedInput, {
      ...assignment,
      surface: {
        ...assignment.surface,
        name: target.name,
        selector: target.selector,
      },
    });
    if (outcome.effect === "pass") {
      outcome.observedEffect = `The genuine Browser ${target.label} marker became native-input reachable in its exact owned delegation state. ${outcome.observedEffect}`;
    }
    outcomes.push(outcome);
  }
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
