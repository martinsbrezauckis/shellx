import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  submitReleaseSurfaceInstalledInputPrompt,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { apiJson, nodeReadablePath, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type AttachmentMediaAction =
  | "pending-row-preview"
  | "pending-preview"
  | "pending-remove"
  | "session-row-preview"
  | "session-preview"
  | "asset-row-preview"
  | "asset-preview"
  | "asset-attach"
  | "asset-import"
  | "image-preview"
  | "video-preview"
  | "video-playback"
  | "inspect-prompt"
  | "summarize-prompt"
  | "board-find-prompt"
  | "bottom-find-prompt";

const ACTION_BY_SURFACE: Record<string, AttachmentMediaAction> = {
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-9\"]": "pending-row-preview",
  "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Preview file\"]#pending": "pending-preview",
  "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Remove attachment\"]": "pending-remove",
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-12\"]": "session-row-preview",
  "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Preview file\"]#session": "session-preview",
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-14\"]": "asset-row-preview",
  "src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Preview \"]": "asset-preview",
  "src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Attach \"]": "asset-attach",
  "src/components/AttachmentMediaBoard.tsx:[aria-label^=\"Import \"]": "asset-import",
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-18\"]": "image-preview",
  "src/components/AttachmentMediaBoard.tsx:[data-debug-id=\"surface-components-attachmentmediaboard-19\"]": "video-preview",
  "src/components/MediaPreview.tsx:[data-debug-id=\"surface-components-mediapreview-1\"]": "video-playback",
  "src/components/AttachmentMediaBoard.tsx:role=button;name=\"Inspect\"": "inspect-prompt",
  "src/components/AttachmentMediaBoard.tsx:role=button;name=\"Summarize\"": "summarize-prompt",
  "src/components/AttachmentMediaBoard.tsx:role=button;name=\"Find\"": "board-find-prompt",
  "src/components/BottomPanel.tsx:role=button;name=\"Find\"": "bottom-find-prompt",
};

const BOARD = "[role='dialog'][aria-label='Attachment and media board']";
const PREVIEW = "[role='dialog'][aria-label='Preview Center']";
const PREVIEW_CLOSE = `${PREVIEW} [aria-label='Close']`;
const PENDING_ROW = "[data-debug-id='surface-components-attachmentmediaboard-9']";
const PENDING_PREVIEW = `${BOARD} .asset-board-section:nth-of-type(1) [title='Preview file']`;
const PENDING_REMOVE = `${BOARD} .asset-board-section:nth-of-type(1) [title='Remove attachment']`;
const SESSION_ROW = "[data-debug-id='surface-components-attachmentmediaboard-12']";
const SESSION_PREVIEW = `${BOARD} .asset-board-section:nth-of-type(2) [title='Preview file']`;
const ASSET_ROW = "[data-debug-id='surface-components-attachmentmediaboard-14']";
const ASSET_PREVIEW = "[aria-label='Preview release-owned-image.png']";
const ASSET_ATTACH = "[aria-label='Attach release-owned-image.png']";
const ASSET_IMPORT = "[aria-label='Import release-owned-image.png']";
const IMAGE_PREVIEW = "[data-debug-id='surface-components-attachmentmediaboard-18']";
const VIDEO_PREVIEW = "[data-debug-id='surface-components-attachmentmediaboard-19']";
const VIDEO_PLAYBACK = "[data-debug-id='surface-components-mediapreview-1']";
const INSPECT_PROMPT = `${BOARD} .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(3)`;
const SUMMARIZE_PROMPT = `${BOARD} .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(4)`;
const BOARD_FIND_PROMPT = `${BOARD} .asset-board-section:nth-of-type(1) .asset-board-actions > button:nth-child(5)`;
const BOTTOM_FIND_PROMPT = ".composer-attachment-actions > .composer-attachment-action:nth-of-type(3)";
const COMPOSER = "[data-debug-id='composer-prompt']";
const INSPECT_TEXT = "Inspect the attached file. Summarize what each contains and point out anything important I should notice.";
const SUMMARIZE_TEXT = "Summarize the attached file. Keep it concise and include filenames when comparing them.";
const FIND_DIALOG_TEXT = "Find what in the attached files?";
const FIND_QUERY = "SHELLX_RELEASE_FIND_CANARY_035";
const FIND_TEXT = `Find \"${FIND_QUERY}\" in the attached file. Report every relevant match with filename and context.`;
const RELEASE_OWNED_MP4_BASE64 = "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC5m1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHodHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABhG1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAS9taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADvc3RibAAAAKNzdHNkAAAAAAAAAAEAAACTYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjAuMzEuMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAAC1hdmNDAULACv/hABVnQsAK2nsBEAAAAwAQAAADACDxImoBAAVozgOcgAAAABBwYXNwAAAAAQAAAAEAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAHhtb29mAAAAEG1maGQAAAAAAAAAAQAAAGB0cmFmAAAAJHRmaGQAAAA5AAAAAQAAAAAAAAMKAABAAAAAAmUBAQAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAAAgdHJ1bgAAAgUAAAACAAAAgAIAAAAAAAJlAAAACQAAAnZtZGF0AAACUwYF//9P3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9NDAuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAKZYiEOiYoAAgY4AAAAAVBmiAUpQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADCgEBAQAAABBtZnJvAAAAAAAAAEM=";
interface AttachmentMediaFixture {
  nodeRoot: string;
  nodeImportedPath: string;
  nodeImagePath: string;
  launchPendingPath: string;
  launchSessionPath: string;
  launchImagePath: string;
  launchVideoPath: string;
  launchImportedPath: string;
  launchScopeDir: string;
  tabId: string;
  baselineBottomTab: string;
  baselineRightTab: string;
  baselineActiveTab: Record<string, unknown>;
  baselineComposer: string;
}

export const ATTACHMENT_MEDIA_SAFE_FIXTURES = ["ui:attachment-media-owned-lifecycle"] as const;
export const ATTACHMENT_MEDIA_SAFE_CLEANUPS = ["ui:clear-owned-attachment-media-and-delete-root"] as const;
export const ATTACHMENT_MEDIA_SAFE_ORACLES = [
  "ui:activation:owned-attachment-preview",
  "ui:activation:owned-attachment-removed",
  "ui:activation:owned-asset-imported",
  "ui:activation:owned-asset-attached",
  "ui:activation:owned-attachment-prompt-inserted",
  "ui:boolean-state-transition",
] as const;

export function supportsAttachmentMediaSafeControl(assignment: Assignment): boolean {
  return actionForAssignment(assignment) !== null;
}

export async function exerciseAttachmentMediaSafeControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actionForAssignment(assignment);
  const outcome = emptyOutcome(assignment);
  let fixture: AttachmentMediaFixture | null = null;
  try {
    if (!action) throw new Error(`Attachment/Media driver does not support ${assignment.surface.id}`);
    fixture = prepareFixture(request);
    await hydrateBaseline(connection, fixture);
    if (fixture.baselineBottomTab !== "Chat") {
      await postUi(connection, { bottomTab: "Chat", source: "final-surface-owned-attachment-media-composer-baseline" });
    }
    fixture.baselineComposer = await readComposer(webdriver);
    const playbackAction = action === "video-playback";
    const boardAction = action !== "bottom-find-prompt" && !playbackAction;
    await postUi(connection, {
      bottomTab: "Chat",
      activeTabId: fixture.tabId,
      activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchScopeDir },
      debugAttachPaths: [fixture.launchPendingPath],
      debugRendererFixture: {
        id: "event-projections",
        attachmentPath: fixture.launchSessionPath,
        imagePath: fixture.launchImagePath,
        videoPath: fixture.launchVideoPath,
      },
      ...(playbackAction ? {
        preview: {
          kind: "file",
          path: fixture.launchVideoPath,
          tabId: fixture.tabId,
          sessionCwd: fixture.launchScopeDir,
        },
      } : {}),
      openModal: boardAction ? "assets" : playbackAction ? "preview" : "close",
      source: "final-surface-owned-attachment-media",
    });
    if (boardAction) await waitForInitialBoardState(webdriver);
    const control = await waitForReleaseSurfaceInstalledInputElement(
      webdriver,
      selectorForAction(action),
      { timeoutMs: 10_000, pollMs: 50 },
    );
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    if (action === "board-find-prompt" || action === "bottom-find-prompt") {
      await submitReleaseSurfaceInstalledInputPrompt(webdriver, FIND_DIALOG_TEXT, `  ${FIND_QUERY}  `);
    }
    outcome.invoke = "pass";
    await verifyEffect(connection, webdriver, fixture, action);
    outcome.effect = "pass";
    outcome.observedEffect = observedEffect(action);
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanup(connection, webdriver, fixture));
  }
  return finalize(outcome);
}

function actionForAssignment(assignment: Assignment): AttachmentMediaAction | null {
  if (assignment.surface.name === "src/components/AttachmentMediaBoard.tsx:[aria-label=\"Preview file\"]") {
    if (assignment.surface.id.endsWith("#10")) return ACTION_BY_SURFACE[`${assignment.surface.name}#pending`] ?? null;
    if (assignment.surface.id.endsWith("#13")) return ACTION_BY_SURFACE[`${assignment.surface.name}#session`] ?? null;
  }
  return ACTION_BY_SURFACE[assignment.surface.name] ?? null;
}

function selectorForAction(action: AttachmentMediaAction): string {
  switch (action) {
    case "pending-row-preview": return PENDING_ROW;
    case "pending-preview": return PENDING_PREVIEW;
    case "pending-remove": return PENDING_REMOVE;
    case "session-row-preview": return SESSION_ROW;
    case "session-preview": return SESSION_PREVIEW;
    case "asset-row-preview": return ASSET_ROW;
    case "asset-preview": return ASSET_PREVIEW;
    case "asset-attach": return ASSET_ATTACH;
    case "asset-import": return ASSET_IMPORT;
    case "image-preview": return IMAGE_PREVIEW;
    case "video-preview": return VIDEO_PREVIEW;
    case "video-playback": return VIDEO_PLAYBACK;
    case "inspect-prompt": return INSPECT_PROMPT;
    case "summarize-prompt": return SUMMARIZE_PROMPT;
    case "board-find-prompt": return BOARD_FIND_PROMPT;
    case "bottom-find-prompt": return BOTTOM_FIND_PROMPT;
  }
}

function prepareFixture(request: ReleaseSurfaceDriverRequest): AttachmentMediaFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("Attachment/Media fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-attachment-media-lifecycle");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Attachment/Media fixture escaped the disposable profile");
  }
  if (existsSync(nodeRoot)) throw new Error("Attachment/Media fixture root must not pre-exist");
  const nodeSourceDir = join(nodeRoot, "source");
  const nodeScopeDir = join(nodeRoot, "scope");
  mkdirSync(nodeSourceDir, { recursive: true, mode: 0o700 });
  mkdirSync(nodeScopeDir, { mode: 0o700 });
  writeFileSync(join(nodeSourceDir, "release-owned-pending.txt"), "SHELLX_OWNED_PENDING_ATTACHMENT\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(nodeSourceDir, "release-owned-session.txt"), "SHELLX_OWNED_SESSION_ATTACHMENT\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(nodeSourceDir, "release-owned-image.png"), "SHELLX_OWNED_IMAGE_FIXTURE\n", { flag: "wx", mode: 0o600 });
  writeFileSync(
    join(nodeSourceDir, "release-owned-video.mp4"),
    Buffer.from(RELEASE_OWNED_MP4_BASE64, "base64"),
    { flag: "wx", mode: 0o600 },
  );
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-attachment-media-lifecycle", request.platform);
  const launchSourceDir = portableJoin(launchRoot, "source", request.platform);
  const launchScopeDir = portableJoin(launchRoot, "scope", request.platform);
  return {
    nodeRoot,
    nodeImportedPath: join(nodeScopeDir, ".shellx", "assets", "release-owned-image.png"),
    nodeImagePath: join(nodeSourceDir, "release-owned-image.png"),
    launchPendingPath: portableJoin(launchSourceDir, "release-owned-pending.txt", request.platform),
    launchSessionPath: portableJoin(launchSourceDir, "release-owned-session.txt", request.platform),
    launchImagePath: portableJoin(launchSourceDir, "release-owned-image.png", request.platform),
    launchVideoPath: portableJoin(launchSourceDir, "release-owned-video.mp4", request.platform),
    launchImportedPath: portableJoin(
      portableJoin(launchScopeDir, ".shellx", request.platform),
      "assets",
      request.platform,
    ) + (request.platform === "windows-installed" ? "\\release-owned-image.png" : "/release-owned-image.png"),
    launchScopeDir,
    tabId: "",
    baselineBottomTab: "",
    baselineRightTab: "",
    baselineActiveTab: {},
    baselineComposer: "",
  };
}

async function hydrateBaseline(connection: Connection, fixture: AttachmentMediaFixture): Promise<void> {
  const state = await apiJson(connection, "GET", "/state/ui");
  const activeTab = requiredRecord(state.activeTab, "Attachment/Media baseline activeTab");
  const tabId = typeof activeTab.tabId === "string" ? activeTab.tabId.trim() : "";
  const bottomTab = typeof state.bottomTab === "string" ? state.bottomTab.trim() : "";
  const rightTab = typeof state.rightTab === "string" ? state.rightTab.trim() : "";
  if (!tabId || !bottomTab || !rightTab) throw new Error("Attachment/Media fixture requires a restorable active tab and rails");
  fixture.tabId = tabId;
  fixture.baselineBottomTab = bottomTab;
  fixture.baselineRightTab = rightTab;
  fixture.baselineActiveTab = structuredClone(activeTab);
}

async function waitForInitialBoardState(webdriver: WebDriver): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readBoardState(webdriver);
    if (state.pending === 1 && state.session === 1 && state.assets === 2
      && state.images === 1 && state.videos === 1
      && !await findReleaseSurfaceInstalledInputElement(webdriver, PREVIEW)) return;
    await delay(50);
  }
  throw new Error("Attachment/Media board did not expose the exact isolated owned fixture");
}

async function verifyEffect(
  connection: Connection,
  webdriver: WebDriver,
  fixture: AttachmentMediaFixture,
  action: AttachmentMediaAction,
): Promise<void> {
  if (action === "video-playback") {
    await waitForVideoPlaybackState(webdriver, true, "playing");
    const pause = await waitForReleaseSurfaceInstalledInputElement(webdriver, VIDEO_PLAYBACK);
    await clickReleaseSurfaceInstalledInputElement(webdriver, pause);
    await waitForVideoPlaybackState(webdriver, false, "paused");
    return;
  }
  if (action === "inspect-prompt" || action === "summarize-prompt"
    || action === "board-find-prompt" || action === "bottom-find-prompt") {
    const inserted = action === "inspect-prompt"
      ? INSPECT_TEXT
      : action === "summarize-prompt" ? SUMMARIZE_TEXT : FIND_TEXT;
    const baseline = fixture.baselineComposer.trim();
    const expected = baseline ? `${baseline}\n\n${inserted}` : inserted;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await apiJson(connection, "GET", "/state/ui");
      if (state.bottomTab === "Chat"
        && await readComposer(webdriver) === expected
        && !await findReleaseSurfaceInstalledInputElement(webdriver, BOARD)) return;
      await delay(50);
    }
    throw new Error(`Attachment prompt did not insert the exact ${action} text and close the board`);
  }
  if (action === "pending-remove") {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await readBoardState(webdriver);
      if (state.pending === 0) return;
      await delay(50);
    }
    throw new Error("Attachment removal did not remove exactly the owned pending attachment");
  }
  if (action === "asset-import" || action === "asset-attach") {
    await waitForImportedCopy(fixture);
    if (action === "asset-attach") {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = await readBoardState(webdriver);
        if (state.pending === 2) return;
        await delay(50);
      }
      throw new Error("Attach imported asset did not add exactly one owned pending attachment");
    }
    const state = await readBoardState(webdriver);
    if (state.pending !== 1) {
      throw new Error("Import asset unexpectedly attached or changed pending attachment state");
    }
    return;
  }
  const expectedPath = previewPathForAction(fixture, action);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const preview = state.preview && typeof state.preview === "object" && !Array.isArray(state.preview)
      ? state.preview as Record<string, unknown>
      : null;
    if (preview?.kind === "file" && preview.path === expectedPath
      && preview.tabId === fixture.tabId && await findReleaseSurfaceInstalledInputElement(webdriver, PREVIEW)) return;
    await delay(50);
  }
  throw new Error("Attachment/Media preview did not open the exact owned path and tab context");
}

async function waitForVideoPlaybackState(
  webdriver: WebDriver,
  pressed: boolean,
  state: "playing" | "paused",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(
      webdriver,
      VIDEO_PLAYBACK,
      ["pressed", "title"],
    );
    if (value.present && value.visible
      && value.pressed === pressed
      && value.title === `Video playback · state=${state}`) return;
    await delay(50);
  }
  throw new Error(`owned video did not reach exact ${state} playback state`);
}

function previewPathForAction(fixture: AttachmentMediaFixture, action: AttachmentMediaAction): string {
  if (action === "pending-row-preview" || action === "pending-preview") return fixture.launchPendingPath;
  if (action === "session-row-preview" || action === "session-preview") return fixture.launchSessionPath;
  if (action === "asset-row-preview" || action === "video-preview") return fixture.launchVideoPath;
  return fixture.launchImagePath;
}

async function waitForImportedCopy(fixture: AttachmentMediaFixture): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(fixture.nodeImportedPath)
      && !lstatSync(fixture.nodeImportedPath).isSymbolicLink()
      && readFileSync(fixture.nodeImportedPath).equals(readFileSync(fixture.nodeImagePath))) return;
    await delay(50);
  }
  throw new Error("Asset import did not create the exact owned copy with matching bytes");
}

async function readBoardState(
  webdriver: WebDriver,
): Promise<{ pending: number; session: number; assets: number; images: number; videos: number }> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, BOARD, ["title"]);
  const match = state.title?.match(/^Attachment board state: pending=(\d+); session=(\d+); assets=(\d+); images=(\d+); videos=(\d+)$/);
  if (!state.present || !state.visible || !match) {
    throw new Error("Attachment/Media board omitted its bounded count receipt");
  }
  return {
    pending: Number(match[1]),
    session: Number(match[2]),
    assets: Number(match[3]),
    images: Number(match[4]),
    videos: Number(match[5]),
  };
}

async function cleanup(
  connection: Connection,
  webdriver: WebDriver,
  fixture: AttachmentMediaFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    if (await findReleaseSurfaceInstalledInputElement(webdriver, PREVIEW)) {
      const close = await waitForReleaseSurfaceInstalledInputElement(webdriver, PREVIEW_CLOSE, { timeoutMs: 5_000, pollMs: 50 });
      await clickReleaseSurfaceInstalledInputElement(webdriver, close);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PREVIEW, { timeoutMs: 5_000, pollMs: 50 });
    }
    if (await readComposer(webdriver) !== fixture.baselineComposer) {
      await replaceComposer(webdriver, fixture.baselineComposer);
    }
    await postUi(connection, {
      debugRemoveAttachmentPaths: [fixture.launchPendingPath, fixture.launchImportedPath],
      debugRendererFixture: "clear",
      clearPreview: true,
      openModal: "close",
      bottomTab: fixture.baselineBottomTab,
      rightTab: fixture.baselineRightTab,
      activeTabId: fixture.tabId,
      activeTab: fixture.baselineActiveTab,
      source: "final-surface-owned-attachment-media-cleanup",
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, BOARD, { timeoutMs: 5_000, pollMs: 50 });
    const restored = await apiJson(connection, "GET", "/state/ui");
    if (restored.bottomTab !== fixture.baselineBottomTab
      || restored.rightTab !== fixture.baselineRightTab
      || JSON.stringify(restored.activeTab) !== JSON.stringify(fixture.baselineActiveTab)
      || restored.preview !== null) {
      throw new Error("Attachment/Media cleanup did not restore the exact UI baseline");
    }
    if (fixture.baselineBottomTab === "Chat" && await readComposer(webdriver) !== fixture.baselineComposer) {
      throw new Error("Attachment/Media cleanup did not restore the exact composer baseline");
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned Attachment/Media fixture root remained");
  } catch (error) {
    errors.push(errorText(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function observedEffect(action: AttachmentMediaAction): string {
  if (action === "video-playback") {
    return "Native WebDriver installed input played and then paused the exact owned valid MP4 through the app-owned accessible control before fixture cleanup.";
  }
  if (action === "inspect-prompt" || action === "summarize-prompt"
    || action === "board-find-prompt" || action === "bottom-find-prompt") {
    return "Native WebDriver installed input inserted the exact owned attachment-analysis draft, closed the board, and did not launch a provider session.";
  }
  if (action === "pending-remove") {
    return "Native WebDriver installed input removed exactly one owned temporary pending attachment without deleting or touching its source file.";
  }
  if (action === "asset-import") {
    return "Native WebDriver installed input copied exactly one owned reusable image into the disposable scope with byte-identical contents and did not attach it.";
  }
  if (action === "asset-attach") {
    return "Native WebDriver installed input copied exactly one owned reusable image into the disposable scope and attached only that imported copy as a pending chip.";
  }
  return "Native WebDriver installed input opened Preview Center for the exact owned temporary attachment or media path and preserved its source-tab context.";
}

async function readComposer(webdriver: WebDriver): Promise<string> {
  const value = await observeReleaseSurfaceInstalledInputElement(webdriver, COMPOSER, ["value"]);
  if (typeof value.value !== "string") throw new Error("Attachment/Media composer omitted its bounded value");
  return value.value;
}

async function replaceComposer(webdriver: WebDriver, value: string): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, COMPOSER);
  await clearReleaseSurfaceInstalledInputElement(webdriver, control);
  if (value) await setReleaseSurfaceInstalledInputElementValue(webdriver, control, value);
  if (await readComposer(webdriver) !== value) throw new Error("Attachment/Media composer restoration did not read back exactly");
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("Attachment/Media token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native owned Attachment/Media lifecycle effect was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (!error) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Attachment/Media control did not satisfy every required verdict";
  }
  return outcome;
}
