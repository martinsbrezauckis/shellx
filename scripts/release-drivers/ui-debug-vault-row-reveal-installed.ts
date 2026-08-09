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
  VAULT_OWNED_REVEAL_MARKER_CLEANUP,
  VAULT_OWNED_REVEAL_MARKER_FIXTURE,
  VAULT_OWNED_REVEAL_MARKER_ORACLE,
  VAULT_OWNED_REVEAL_MARKER_SURFACE_ID,
  exerciseOwnedVaultRevealMarker,
} from "./ui-control-vault-owned-edit";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-vault-row-reveal-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/ui-control-vault-owned-edit.ts",
  ],
  supportedFixtures: [VAULT_OWNED_REVEAL_MARKER_FIXTURE],
  supportedCleanups: [VAULT_OWNED_REVEAL_MARKER_CLEANUP],
  supportedOracles: [VAULT_OWNED_REVEAL_MARKER_ORACLE],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    if (assignment.surface.id !== VAULT_OWNED_REVEAL_MARKER_SURFACE_ID) {
      throw new Error(`owned Vault reveal-marker driver does not support ${assignment.surface.id}`);
    }
    outcomes.push(await exerciseOwnedVaultRevealMarker(connection, installedInput, assignment));
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

runReleaseSurfaceDriverCli(manifest, execute);
