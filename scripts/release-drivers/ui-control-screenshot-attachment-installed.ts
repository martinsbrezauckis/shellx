import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  clickReleaseSurfaceInstalledInputElement,
  createReleaseSurfaceInstalledInputSession,
  findReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupOwnedScreenshotAttachmentProof,
  prepareOwnedScreenshotAttachmentProof,
  verifyOwnedScreenshotAttachmentChip,
  waitForOwnedScreenshotAttachment,
  type OwnedScreenshotAttachmentProof,
} from "./owned-screenshot-attachment";

const ATTACHMENT_BOARD_SCREENSHOT_SURFACE =
  'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach app screenshot"]@src/components/AttachmentMediaBoard.tsx#5';
const COMPOSER_SCREENSHOT_SURFACE =
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-screenshot"]@src/components/BottomPanel.tsx#16';
const ATTACHMENT_BOARD = "[role='dialog'][aria-label='Attachment and media board']";
const ATTACHMENT_BOARD_SCREENSHOT = "[title='Attach app screenshot']";
const COMPOSER_SCREENSHOT = "[data-debug-id='composer-screenshot']";
const ATTACHMENT_CHIP = ".composer-attachment-chip.composer-attachment-image";
const ATTACHMENT_REMOVE = ".composer-attachment-remove";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "ui-control-screenshot-attachment-installed",
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/release-drivers/owned-screenshot-attachment.ts",
  ],
  supportedFixtures: ["ui:isolated-profile-empty-composer-screenshot"],
  supportedCleanups: ["ui:remove-exact-screenshot-attachment-delete-owned-png-restore-view"],
  supportedOracles: ["ui:activation:owned-app-screenshot-attached"],
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    if (assignment.surface.id !== ATTACHMENT_BOARD_SCREENSHOT_SURFACE
      && assignment.surface.id !== COMPOSER_SCREENSHOT_SURFACE) {
      throw new Error(`screenshot attachment driver does not support ${assignment.surface.id}`);
    }
    outcomes.push(await exerciseScreenshotAttachment(connection, input, request, assignment));
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

async function exerciseScreenshotAttachment(
  connection: { base: string; token: string },
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned screenshot attachment effect was observed.",
  };
  let proof: OwnedScreenshotAttachmentProof | null = null;
  try {
    await postUi(connection, { openModal: "close", bottomTab: "Chat", debugHighlights: [] });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, ATTACHMENT_CHIP);
    proof = prepareOwnedScreenshotAttachmentProof(request);
    const attachmentBoard = assignment.surface.id === ATTACHMENT_BOARD_SCREENSHOT_SURFACE;
    if (attachmentBoard) {
      await postUi(connection, { openModal: "assets" });
      await waitForReleaseSurfaceInstalledInputElement(input, ATTACHMENT_BOARD);
    }
    const selector = attachmentBoard ? ATTACHMENT_BOARD_SCREENSHOT : COMPOSER_SCREENSHOT;
    const control = await waitForReleaseSurfaceInstalledInputElement(input, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    const screenshot = await waitForOwnedScreenshotAttachment(proof);
    proof.createdLocalPath = screenshot.localPath;
    if (attachmentBoard) {
      await postUi(connection, { openModal: "close", debugHighlights: [] });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, ATTACHMENT_BOARD);
    }
    await waitForReleaseSurfaceInstalledInputElement(input, ATTACHMENT_CHIP);
    await verifyOwnedScreenshotAttachmentChip(input, screenshot.launchPath);
    outcome.effect = "pass";
    outcome.observedEffect = "A native click invoked the production app-window capture path, created one regular PNG inside the isolated profile, and attached that exact path as a removable image chip.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await postUi(connection, { openModal: "close", bottomTab: "Chat", debugHighlights: [] });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, ATTACHMENT_BOARD);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    try {
      const remove = await findReleaseSurfaceInstalledInputElement(input, ATTACHMENT_REMOVE);
      if (remove) await clickReleaseSurfaceInstalledInputElement(input, remove);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, ATTACHMENT_CHIP);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    try {
      cleanupOwnedScreenshotAttachmentProof(proof);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (cleanupErrors.length) {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    } else {
      outcome.cleanup = "pass";
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "screenshot attachment did not satisfy every required verdict";
  }
  return outcome;
}

async function postUi(
  connection: { base: string; token: string },
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      debugSurface: "app",
      source: "final-surface-ui-screenshot-attachment-driver",
      ...body,
    }),
  });
  if (!response.ok) throw new Error(`POST /state/ui failed ${response.status}: ${await response.text()}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
