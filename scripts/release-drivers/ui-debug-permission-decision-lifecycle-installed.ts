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
  PERMISSION_MARKER_CLEANUPS,
  PERMISSION_MARKER_FIXTURES,
  PERMISSION_MARKER_ORACLES,
  exercisePermissionDecisionMarkers,
  supportsPermissionDecisionMarker,
} from "./ui-permission-decision-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-permission-decision-lifecycle-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "src/lib/debug-permission-decision-fixture.ts",
    "scripts/release-drivers/ui-permission-decision-lifecycle.ts",
  ],
  supportedFixtures: [...PERMISSION_MARKER_FIXTURES],
  supportedCleanups: [...PERMISSION_MARKER_CLEANUPS],
  supportedOracles: [...PERMISSION_MARKER_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  if (!request.assignments.every(supportsPermissionDecisionMarker)) {
    throw new Error("permission decision marker driver received an unsupported assignment");
  }
  const outcomes = await exercisePermissionDecisionMarkers(
    connection,
    installedInput,
    request.assignments,
  );
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
