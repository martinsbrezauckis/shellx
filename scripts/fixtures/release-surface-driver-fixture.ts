import { writeFileSync } from "node:fs";
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
  id: "fixture-installed",
  kind: "tauri-command",
  runtimeBinding: "attested-process",
  invocationTransport: "process-cli",
  supportedFixtures: ["fixture:isolated-profile"],
  supportedCleanups: ["fixture:remove-isolated-profile", "tauri:discard-with-candidate-profile"],
  supportedOracles: ["fixture:isolated-result"],
};

runReleaseSurfaceDriverCli(manifest, async (request: ReleaseSurfaceDriverRequest) => {
  const startedAt = new Date().toISOString();
  const mutationPath = process.env.SHELLX_RELEASE_FIXTURE_MUTATE_INSTALLED_PATH;
  if (mutationPath) writeFileSync(mutationPath, "driver-mutated-installed-payload", "utf8");
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
      effect: "pass",
      cleanup: "pass",
      observedEffect: assignment.expectedEffect,
    })),
  };
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
