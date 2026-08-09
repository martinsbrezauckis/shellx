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
  LEFT_RAIL_LIFECYCLE_CLEANUPS,
  LEFT_RAIL_LIFECYCLE_DRIVER_ID,
  LEFT_RAIL_LIFECYCLE_FIXTURES,
  LEFT_RAIL_LIFECYCLE_ORACLES,
  exerciseLeftRailLifecycleCohort,
  supportsLeftRailLifecycleControl,
} from "./ui-control-left-rail-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: LEFT_RAIL_LIFECYCLE_DRIVER_ID,
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-webdriver-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/native/macos-release-input.swift",
    "scripts/release-drivers/debug-api-session-fixture.ts",
    "scripts/release-drivers/ui-control-left-rail-lifecycle.ts",
  ],
  supportedFixtures: [...LEFT_RAIL_LIFECYCLE_FIXTURES],
  supportedCleanups: [...LEFT_RAIL_LIFECYCLE_CLEANUPS],
  supportedOracles: [...LEFT_RAIL_LIFECYCLE_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  if (request.assignments.some((assignment) => !supportsLeftRailLifecycleControl(assignment))) {
    throw new Error("left-rail lifecycle driver received a surface outside its exact reversible cohort");
  }
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = await exerciseLeftRailLifecycleCohort(connection, input, request, request.assignments);
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
