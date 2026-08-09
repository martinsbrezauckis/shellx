import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import type { ReleaseSurfaceKind } from "../lib/release-surface-inventory";
import {
  TRUSTED_VAULT_FILL_CLEANUPS,
  TRUSTED_VAULT_FILL_FIXTURES,
  TRUSTED_VAULT_FILL_ORACLES,
  createTrustedVaultFillInstalledInput,
  exerciseTrustedVaultFillSurface,
  supportsTrustedVaultFillSurface,
} from "./trusted-vault-fill-lifecycle";

type Transport = ReleaseSurfaceDriverManifest["invocationTransport"];

export function runTrustedVaultFillDriver(input: {
  id: string;
  kind: ReleaseSurfaceKind;
  invocationTransport: Transport;
  controllerFiles?: string[];
}): void {
  const manifest: ReleaseSurfaceDriverManifest = {
    schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
    id: input.id,
    kind: input.kind,
    runtimeBinding: "attested-process",
    invocationTransport: input.invocationTransport,
    supportedFixtures: [...TRUSTED_VAULT_FILL_FIXTURES],
    supportedCleanups: [...TRUSTED_VAULT_FILL_CLEANUPS],
    supportedOracles: [...TRUSTED_VAULT_FILL_ORACLES],
    controllerFiles: [
      "scripts/lib/release-surface-webdriver-client.ts",
      "scripts/shellx-browser-test-cleanup.ts",
      "scripts/release-drivers/trusted-vault-fill-driver.ts",
      "scripts/release-drivers/trusted-vault-fill-lifecycle.ts",
      ...(input.controllerFiles ?? []),
    ].sort(),
  };

  runReleaseSurfaceDriverCli(manifest, async (request) => execute(manifest, request));
}

async function execute(
  manifest: ReleaseSurfaceDriverManifest,
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const needsInput = request.driverKind === "ui-control" || request.driverKind === "ui-debug-surface";
  const installedInput = needsInput ? createTrustedVaultFillInstalledInput(request, connection) : undefined;
  const outcomes = [];
  for (const assignment of request.assignments) {
    if (!supportsTrustedVaultFillSurface(assignment) || assignment.surface.kind !== manifest.kind) {
      throw new Error(`trusted Vault fill driver does not support ${assignment.surface.id}`);
    }
    outcomes.push(await exerciseTrustedVaultFillSurface(connection, request, assignment, installedInput));
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
