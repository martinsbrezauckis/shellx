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
import {
  WINDOWS_DESKTOP_INTEGRATION_UI_CLEANUPS,
  WINDOWS_DESKTOP_INTEGRATION_UI_FIXTURES,
  WINDOWS_DESKTOP_INTEGRATION_UI_ORACLES,
  exerciseWindowsDesktopIntegrationControl,
  supportsWindowsDesktopIntegrationControl,
} from "./ui-control-windows-desktop-integration";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-windows-desktop-integration-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/release-drivers/ui-control-windows-desktop-integration.ts",
    "scripts/release-drivers/windows-desktop-integration-lifecycle.ts",
    "scripts/probe-release-surface-windows-desktop-integration.ps1",
  ],
  supportedFixtures: [...WINDOWS_DESKTOP_INTEGRATION_UI_FIXTURES],
  supportedCleanups: [...WINDOWS_DESKTOP_INTEGRATION_UI_CLEANUPS],
  supportedOracles: [...WINDOWS_DESKTOP_INTEGRATION_UI_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    if (!supportsWindowsDesktopIntegrationControl(assignment)) {
      throw new Error(`Desktop integration UI driver does not support ${assignment.surface.name}`);
    }
    outcomes.push(await exerciseWindowsDesktopIntegrationControl(connection, input, request, assignment));
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
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
