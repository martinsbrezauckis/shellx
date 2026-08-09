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
  CHAT_OUTPUT_JUMP_DEBUG_CLEANUPS,
  CHAT_OUTPUT_JUMP_DEBUG_FIXTURES,
  CHAT_OUTPUT_JUMP_DEBUG_ORACLES,
  exerciseChatOutputJumpDebugSurface,
  supportsChatOutputJumpDebugSurface,
} from "./ui-control-chat-output-lifecycle";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-debug-chat-output-jump-lifecycle-installed",
  kind: "ui-debug-surface",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "src/lib/debug-renderer-fixture.ts",
    "scripts/release-drivers/ui-control-chat-output-lifecycle.ts",
  ],
  supportedFixtures: [...CHAT_OUTPUT_JUMP_DEBUG_FIXTURES],
  supportedCleanups: [...CHAT_OUTPUT_JUMP_DEBUG_CLEANUPS],
  supportedOracles: [...CHAT_OUTPUT_JUMP_DEBUG_ORACLES],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  if (request.assignments.length !== 1 || !request.assignments.every(supportsChatOutputJumpDebugSurface)) {
    throw new Error("ChatOutput Jump debug driver requires exactly its one native-scroll marker assignment");
  }
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [await exerciseChatOutputJumpDebugSurface(
    connection,
    installedInput,
    request.assignments[0]!,
  )];
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
