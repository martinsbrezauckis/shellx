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
  VAULT_REQUEST_PROMPT_CLEANUPS,
  VAULT_REQUEST_PROMPT_FIXTURES,
  VAULT_REQUEST_PROMPT_ORACLES,
  exerciseVaultRequestPromptSurface,
  supportsVaultRequestPromptSurface,
} from "./ui-vault-request-prompt-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-vault-request-prompt-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/debug-api-browser-settle-fixture.ts",
    "scripts/shellx-browser-test-cleanup.ts",
    "scripts/release-drivers/ui-vault-request-prompt-lifecycle.ts",
  ],
  supportedFixtures: [...VAULT_REQUEST_PROMPT_FIXTURES],
  supportedCleanups: [...VAULT_REQUEST_PROMPT_CLEANUPS],
  supportedOracles: [...VAULT_REQUEST_PROMPT_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    if (!supportsVaultRequestPromptSurface(assignment) || assignment.surface.kind !== "ui-control") {
      throw new Error(`Vault request/prompt control driver does not support ${assignment.surface.id}`);
    }
    outcomes.push(await exerciseVaultRequestPromptSurface(connection, input, request, assignment));
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
