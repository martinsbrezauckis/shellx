import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "fixture-a-failing-installed",
  kind: "tauri-command",
  runtimeBinding: "attested-process",
  invocationTransport: "process-cli",
  supportedFixtures: ["fixture:expected-failure"],
  supportedCleanups: ["tauri:discard-with-candidate-profile"],
  supportedOracles: ["fixture:expected-failure"],
};

runReleaseSurfaceDriverCli(manifest, async (request: ReleaseSurfaceDriverRequest) => {
  const startedAt = new Date().toISOString();
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
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes: request.assignments.map((assignment) => ({
      id: assignment.surface.id,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      present: "pass",
      invoke: "pass",
      effect: "fail",
      cleanup: "pass",
      observedEffect: "The synthetic discovery finding was recorded and cleaned up.",
      error: "synthetic discovery finding",
    })),
  };
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
