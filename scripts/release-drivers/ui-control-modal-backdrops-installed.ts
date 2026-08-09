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
  MODAL_BACKDROP_CLEANUPS,
  MODAL_BACKDROP_FIXTURES,
  MODAL_BACKDROP_ORACLES,
  exerciseModalBackdropControl,
  supportsModalBackdropControl,
} from "./ui-control-modal-backdrops";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-modal-backdrops-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-webdriver-client.ts",
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/ui-control-modal-backdrops.ts",
  ],
  supportedFixtures: [...MODAL_BACKDROP_FIXTURES],
  supportedCleanups: [...MODAL_BACKDROP_CLEANUPS],
  supportedOracles: [...MODAL_BACKDROP_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    if (!supportsModalBackdropControl(assignment)) {
      throw new Error(`modal-backdrop driver does not support ${assignment.surface.name}`);
    }
    outcomes.push(await exerciseModalBackdropControl(connection, installedInput, assignment));
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
