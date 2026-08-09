import { lstatSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { nodeReadablePath } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type UiTab = Record<string, unknown> & { tabId: string };

const PREFIX = "src/components/BottomPanel.tsx:";
const REMOVE = `${PREFIX}[aria-label^="Remove "]`;
const CLOSE_TERMINAL = `${PREFIX}[aria-label="close terminal tab"]`;
const SLASH_ROW = `${PREFIX}[data-debug-id="surface-components-bottompanel-24"]`;
const MEDIA_CARD = `${PREFIX}[data-debug-id="surface-components-bottompanel-9"]`;
const ACP_TERMINAL = `${PREFIX}[title^="ACP terminal "]`;
const INSPECT = `${PREFIX}role=button;name="Inspect"`;
const SHELL = `${PREFIX}role=button;name="shell"`;
const SUMMARIZE = `${PREFIX}role=button;name="Summarize"`;
const AGENT_ROW = `${PREFIX}[data-debug-id="surface-components-bottompanel-23"]`;
const VOICE_OFF = `${PREFIX}[aria-label="Turn voice chat off and cancel active listening"]`;
const MIC_CONTROL = 'src/components/MicButton.tsx:[data-release-control="composer-mic-button"]';
const SUPPORTED = new Set([
  REMOVE,
  CLOSE_TERMINAL,
  SLASH_ROW,
  MEDIA_CARD,
  ACP_TERMINAL,
  INSPECT,
  SHELL,
  SUMMARIZE,
  AGENT_ROW,
  VOICE_OFF,
  MIC_CONTROL,
]);

const NEW_TAB = ".stab-new[title='New session (⌘T)']";
const PROMPT = "[data-debug-id='composer-prompt']";
const INSPECT_BUTTON = ".composer-attachment-actions > .composer-attachment-action:nth-of-type(1)";
const SUMMARIZE_BUTTON = ".composer-attachment-actions > .composer-attachment-action:nth-of-type(2)";
const SLASH_BUTTON = "[data-debug-id='surface-components-bottompanel-24']";
const SHELL_BUTTON = ".terminal-substrip > button.substrip-tab";
const AGENT_BUTTON = "[data-debug-id='composer-agent']";
const AGENT_MENU = "[data-agent-picker-root][role='menu'][aria-label='Agent']";
const VOICE_OFF_BUTTON = "[aria-label='Turn voice chat off and cancel active listening']";
const VOICE_CHAT_BUTTON = "[data-debug-id='composer-voice-chat']";
const CODEX_ROW = "[data-debug-id='surface-components-bottompanel-23'][data-agent-id='codex-cli']";
const PREVIEW_DIALOG = "[role='dialog'][aria-label='Preview Center']";
const OWNED_ATTACHMENT_NAME = "owned-attachment.txt";
const OWNED_IMAGE_NAME = "owned-image.png";
const FIXTURE_ID = "bottom-panel-lifecycle";

interface OwnedTab {
  baselineTabs: UiTab[];
  baselineActiveId: string;
  baselineBottomTab: string;
  baselinePreview: Record<string, unknown> | null;
  tabId: string;
}

interface OwnedFiles {
  nodeRoot: string;
  attachmentLaunchPath: string;
  imageLaunchPath: string;
}

interface ComposerState {
  prompt: string;
}

interface TerminalState {
  mounted: boolean;
  ids: string[];
  active: string | null;
  fixtureUserVisible: boolean;
}

export const BOTTOM_PANEL_LIFECYCLE_FIXTURES = [
  "ui:bottom-panel-owned-tab-attachment",
  "ui:bottom-panel-owned-tab-slash-command",
  "ui:bottom-panel-owned-tab-media",
  "ui:bottom-panel-owned-tab-terminal-projection",
  "ui:bottom-panel-owned-tab-agent-choice",
  "ui:bottom-panel-owned-tab-voice-capture",
  "ui:bottom-panel-owned-tab-mic-stop",
] as const;

export const BOTTOM_PANEL_LIFECYCLE_CLEANUPS = [
  "ui:remove-owned-attachment-clear-prompt-delete-files-close-tab-restore-baseline",
  "ui:clear-owned-prompt-close-tab-restore-baseline",
  "ui:close-preview-clear-owned-events-delete-files-close-tab-restore-baseline",
  "ui:clear-owned-terminal-projection-close-tab-restore-baseline",
  "ui:clear-owned-agent-scan-close-tab-restore-baseline",
  "ui:clear-owned-voice-capture-close-tab-restore-baseline",
  "ui:clear-owned-mic-stop-close-tab-restore-baseline",
] as const;

export const BOTTOM_PANEL_LIFECYCLE_ORACLES = [
  "ui:activation:owned-attachment-removed",
  "ui:activation:owned-attachment-prompt-transition",
  "ui:selection-state-transition",
  "ui:activation:owned-media-preview-opened",
  "ui:activation:owned-terminal-selection-transition",
  "ui:boolean-state-transition",
  "ui:activation:owned-voice-capture-cancelled",
  "ui:activation:owned-mic-capture-stopped",
] as const;

export function supportsBottomPanelLifecycleControl(assignment: Assignment): boolean {
  return SUPPORTED.has(assignment.surface.name);
}

function assertAssignmentContract(assignment: Assignment): void {
  const expected = assignmentContract(assignment.surface.name);
  if (assignment.fixtureId !== expected.fixtureId
    || assignment.oracleId !== expected.oracleId
    || assignment.cleanupId !== expected.cleanupId) {
    throw new Error(`BottomPanel lifecycle assignment contract drifted for ${assignment.surface.name}`);
  }
}

function assignmentContract(surfaceName: string): {
  fixtureId: string;
  oracleId: string;
  cleanupId: string;
} {
  if ([REMOVE, INSPECT, SUMMARIZE].includes(surfaceName)) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-attachment",
      oracleId: surfaceName === REMOVE
        ? "ui:activation:owned-attachment-removed"
        : "ui:activation:owned-attachment-prompt-transition",
      cleanupId: "ui:remove-owned-attachment-clear-prompt-delete-files-close-tab-restore-baseline",
    };
  }
  if (surfaceName === SLASH_ROW) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-slash-command",
      oracleId: "ui:selection-state-transition",
      cleanupId: "ui:clear-owned-prompt-close-tab-restore-baseline",
    };
  }
  if (surfaceName === MEDIA_CARD) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-media",
      oracleId: "ui:activation:owned-media-preview-opened",
      cleanupId: "ui:close-preview-clear-owned-events-delete-files-close-tab-restore-baseline",
    };
  }
  if (surfaceName === AGENT_ROW) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-agent-choice",
      oracleId: "ui:boolean-state-transition",
      cleanupId: "ui:clear-owned-agent-scan-close-tab-restore-baseline",
    };
  }
  if (surfaceName === VOICE_OFF) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-voice-capture",
      oracleId: "ui:activation:owned-voice-capture-cancelled",
      cleanupId: "ui:clear-owned-voice-capture-close-tab-restore-baseline",
    };
  }
  if (surfaceName === MIC_CONTROL) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-mic-stop",
      oracleId: "ui:activation:owned-mic-capture-stopped",
      cleanupId: "ui:clear-owned-mic-stop-close-tab-restore-baseline",
    };
  }
  if ([CLOSE_TERMINAL, ACP_TERMINAL, SHELL].includes(surfaceName)) {
    return {
      fixtureId: "ui:bottom-panel-owned-tab-terminal-projection",
      oracleId: surfaceName === CLOSE_TERMINAL
        ? "ui:activation:owned-terminal-selection-transition"
        : "ui:boolean-state-transition",
      cleanupId: "ui:clear-owned-terminal-projection-close-tab-restore-baseline",
    };
  }
  throw new Error(`BottomPanel lifecycle driver does not support ${surfaceName}`);
}

export async function exerciseBottomPanelLifecycleControl(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  if (!supportsBottomPanelLifecycleControl(assignment)) {
    throw new Error(`BottomPanel lifecycle driver does not support ${assignment.surface.name}`);
  }
  assertAssignmentContract(assignment);
  if (assignment.surface.name === SLASH_ROW) {
    return exerciseSlashCommand(connection, input, assignment);
  }
  if (assignment.surface.name === MEDIA_CARD) {
    return exerciseMediaPreview(connection, input, request, assignment);
  }
  if (assignment.surface.name === AGENT_ROW) {
    return exerciseAgentChoice(connection, input, assignment);
  }
  if (assignment.surface.name === VOICE_OFF) {
    return exerciseVoiceOff(connection, input, assignment);
  }
  if (assignment.surface.name === MIC_CONTROL) {
    return exerciseMicStop(connection, input, assignment);
  }
  if ([CLOSE_TERMINAL, ACP_TERMINAL, SHELL].includes(assignment.surface.name)) {
    return exerciseTerminal(connection, input, request, assignment);
  }
  return exerciseAttachment(connection, input, request, assignment);
}

async function exerciseVoiceOff(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let baselinePrompt = "";
  try {
    tab = await createOwnedTab(connection, input);
    baselinePrompt = (await composerState(input)).prompt;
    await postUi(connection, {
      bottomTab: "Chat",
      releaseTestVoiceCapture: "recording",
      source: "final-surface-bottom-panel-voice-off",
    });
    const control = await waitForReleaseSurfaceInstalledInputElement(input, VOICE_OFF_BUTTON);
    const recording = await observeReleaseSurfaceInstalledInputElement(input, VOICE_CHAT_BUTTON, ["title"]);
    if (!recording.present || !recording.visible
      || typeof recording.title !== "string" || !recording.title.startsWith("Recording ")) {
      throw new Error("owned voice fixture did not enter the real MicButton recording state");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, VOICE_OFF_BUTTON);
    const idle = await waitForVoiceButtonTitle(input, "Voice chat — STT + spoken reply playback");
    if (!idle.present || !idle.visible) throw new Error("voice-chat mic did not remain visible after cancellation");
    outcome.effect = "pass";
    outcome.observedEffect = "A native click invoked the real voice-chat MicButton cancel path from an isolated active capture, returned it to the exact idle title, cleared the owned tab's voice mode, and removed the off control without requesting a microphone or transcription provider.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, null, baselinePrompt, {
      clearVoiceFixture: true,
    }));
  }
  return finalize(outcome);
}

async function exerciseMicStop(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let baselinePrompt = "";
  try {
    tab = await createOwnedTab(connection, input);
    baselinePrompt = (await composerState(input)).prompt;
    await postUi(connection, {
      bottomTab: "Chat",
      debugAgentPickerFixture: "owned-ready",
      source: "final-surface-bottom-panel-mic-agent",
    });
    const agent = await waitForReleaseSurfaceInstalledInputElement(input, AGENT_BUTTON);
    await clickReleaseSurfaceInstalledInputElement(input, agent);
    await waitForReleaseSurfaceInstalledInputElement(input, AGENT_MENU);
    const codex = await waitForReleaseSurfaceInstalledInputElement(input, CODEX_ROW);
    await clickReleaseSurfaceInstalledInputElement(input, codex);
    await waitForUiState(connection, (state) => (
      state.activeTabId === tab!.tabId && record(state.activeTab)?.agentId === "codex-cli"
    ), "owned MicButton agent baseline");
    await postUi(connection, {
      releaseTestVoiceCapture: "recording",
      source: "final-surface-bottom-panel-mic-stop",
    });
    await waitForVoiceButtonTitlePrefix(input, "Recording ");
    const recording = await waitForReleaseSurfaceInstalledInputElement(input, VOICE_CHAT_BUTTON);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, recording);
    outcome.invoke = "pass";
    await waitForVoiceButtonTitle(input, "Voice chat — STT + spoken reply playback");
    await waitForReleaseSurfaceInstalledInputElement(input, VOICE_OFF_BUTTON);
    outcome.effect = "pass";
    outcome.observedEffect = "A native click invoked the real MicButton stop boundary from an isolated active capture, returned the exact control to idle, and retained voice mode until explicit cleanup without requesting a device or provider.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, null, baselinePrompt, {
      clearAgentPickerFixture: true,
      clearVoiceFixture: true,
      turnOffVoiceMode: true,
    }));
  }
  return finalize(outcome);
}

async function waitForVoiceButtonTitle(input: InstalledInput, expected: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(input, VOICE_CHAT_BUTTON, ["title"]);
    if (state.present && state.visible && state.title === expected) return state;
    await delay(50);
  }
  throw new Error(`voice-chat button did not reach title ${expected}`);
}

async function waitForVoiceButtonTitlePrefix(input: InstalledInput, expectedPrefix: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(input, VOICE_CHAT_BUTTON, ["title"]);
    if (state.present && state.visible && typeof state.title === "string" && state.title.startsWith(expectedPrefix)) return state;
    await delay(50);
  }
  throw new Error(`voice-chat button did not reach title prefix ${expectedPrefix}`);
}

async function exerciseAgentChoice(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let baselinePrompt = "";
  try {
    tab = await createOwnedTab(connection, input);
    baselinePrompt = (await composerState(input)).prompt;
    await postUi(connection, {
      bottomTab: "Chat",
      debugAgentPickerFixture: "owned-ready",
      source: "final-surface-bottom-panel-agent-choice",
    });
    const anchor = await waitForReleaseSurfaceInstalledInputElement(input, AGENT_BUTTON);
    await clickReleaseSurfaceInstalledInputElement(input, anchor);
    await waitForReleaseSurfaceInstalledInputElement(input, AGENT_MENU);
    const control = await waitForReleaseSurfaceInstalledInputElement(input, CODEX_ROW);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, AGENT_MENU);
    await waitForUiState(connection, (state) => (
      state.activeTabId === tab!.tabId && record(state.activeTab)?.agentId === "codex-cli"
    ), "owned BottomPanel agent choice");
    outcome.effect = "pass";
    outcome.observedEffect = "A native click persisted Codex only into the exact disposable BottomPanel tab using one bounded ready-scan fixture without launching a provider.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, null, baselinePrompt, {
      clearAgentPickerFixture: true,
    }));
  }
  return finalize(outcome);
}

async function exerciseAttachment(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let files: OwnedFiles | null = null;
  let baselineComposer: ComposerState | null = null;
  try {
    tab = await createOwnedTab(connection, input);
    files = prepareOwnedFiles(request);
    await requireNoAttachmentChips(input, "owned attachment baseline");
    await postUi(connection, {
      bottomTab: "Chat",
      debugAttachPaths: [files.attachmentLaunchPath],
      source: "final-surface-bottom-panel-attachment",
    });
    const ownedAttachment = attachmentSelector(files.attachmentLaunchPath);
    await waitForExactAttachment(input, ownedAttachment, files.attachmentLaunchPath, "owned attachment setup");
    baselineComposer = await composerState(input);
    const baselinePrompt = baselineComposer.prompt;
    const controlSelector = assignment.surface.name === REMOVE
      ? `[aria-label='Remove ${OWNED_ATTACHMENT_NAME}']`
      : assignment.surface.name === INSPECT
        ? INSPECT_BUTTON
        : SUMMARIZE_BUTTON;
    const control = await waitForReleaseSurfaceInstalledInputElement(input, controlSelector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    if (assignment.surface.name === REMOVE) {
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, ownedAttachment);
      await requireNoAttachmentChips(input, "owned attachment removal");
      await waitForComposerState(input, (state) => state.prompt === baselinePrompt, "owned attachment removal");
      outcome.observedEffect = "A native click removed exactly the one owned attachment chip and its inlined text state without changing the composer prompt or any baseline attachment.";
    } else {
      const fileWord = "attached file";
      const inserted = assignment.surface.name === INSPECT
        ? `Inspect the ${fileWord}. Summarize what each contains and point out anything important I should notice.`
        : `Summarize the ${fileWord}. Keep it concise and include filenames when comparing them.`;
      const expected = baselinePrompt.trim() ? `${baselinePrompt.trim()}\n\n${inserted}` : inserted;
      await waitForComposerState(input, (state) => state.prompt === expected, "owned attachment prompt transition");
      await waitForExactAttachment(input, ownedAttachment, files.attachmentLaunchPath, "owned attachment preservation");
      outcome.observedEffect = `A native click inserted the exact ${assignment.surface.name === INSPECT ? "Inspect" : "Summarize"} helper text for the owned attachment without sending it or invoking a provider.`;
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, files, baselineComposer?.prompt ?? "", {
      removeAttachmentPath: files?.attachmentLaunchPath,
    }));
  }
  return finalize(outcome);
}

async function exerciseSlashCommand(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let baselinePrompt = "";
  try {
    tab = await createOwnedTab(connection, input);
    await postUi(connection, { bottomTab: "Chat", source: "final-surface-bottom-panel-slash" });
    const baseline = await composerState(input);
    baselinePrompt = baseline.prompt;
    await setPrompt(input, "/comm");
    await waitForComposerState(input, (state) => state.prompt === "/comm", "owned slash-command prompt");
    const control = await waitForReleaseSurfaceInstalledInputElement(input, SLASH_BUTTON);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForComposerState(input, (state) => state.prompt === "/commands ", "owned slash-command insertion");
    outcome.effect = "pass";
    outcome.observedEffect = "A native click selected the deterministic built-in /commands row and inserted its exact text into the owned tab composer without sending it.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, null, baselinePrompt));
  }
  return finalize(outcome);
}

async function exerciseMediaPreview(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let files: OwnedFiles | null = null;
  let baselinePrompt = "";
  try {
    tab = await createOwnedTab(connection, input);
    files = prepareOwnedFiles(request);
    baselinePrompt = (await composerState(input)).prompt;
    await postUi(connection, {
      bottomTab: "Images",
      debugRendererFixture: {
        id: "event-projections",
        attachmentPath: files.attachmentLaunchPath,
        imagePath: files.imageLaunchPath,
      },
      source: "final-surface-bottom-panel-media",
    });
    const selector = `[data-debug-id='surface-components-bottompanel-9'][title='${cssAttribute(files.imageLaunchPath)}']`;
    const control = await waitForReleaseSurfaceInstalledInputElement(input, selector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(input, PREVIEW_DIALOG);
    await waitForUiState(connection, (state) => (
      state.activeTabId === tab!.tabId
      && record(state.preview)?.path === files!.imageLaunchPath
    ), "owned media preview");
    outcome.effect = "pass";
    outcome.observedEffect = "A native click opened Preview Center for the exact owned event-projected image path on the owned tab without reading or sending unrelated media.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, files, baselinePrompt, {
      clearRendererFixture: true,
      closePreview: true,
    }));
  }
  return finalize(outcome);
}

async function exerciseTerminal(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let tab: OwnedTab | null = null;
  let baselinePrompt = "";
  let baselineTerminal: TerminalState | null = null;
  const terminalId = `release-terminal-${request.sourceCommit.slice(0, 16)}`;
  try {
    if (await terminalMounted(input)) {
      throw new Error("BottomPanel terminal fixture refuses a renderer with an already-mounted baseline terminal");
    }
    tab = await createOwnedTab(connection, input);
    baselinePrompt = (await composerState(input)).prompt;
    await postUi(connection, {
      bottomTab: "Terminal",
      debugRendererFixture: { id: FIXTURE_ID, terminalId, label: "owned fixture" },
      source: "final-surface-bottom-panel-terminal",
    });
    baselineTerminal = { mounted: false, ids: [], active: null, fixtureUserVisible: false };
    const ownedTerminal = `[title='ACP terminal ${terminalId}']`;
    await waitForReleaseSurfaceInstalledInputElement(input, ownedTerminal);
    await waitForTerminalState(input, terminalId, (state) => (
      sameStrings(state.ids, [terminalId]) && state.active === "user" && state.fixtureUserVisible
    ), "owned terminal projection setup");
    let targetSelector = ownedTerminal;
    if (assignment.surface.name === SHELL) {
      const setup = await waitForReleaseSurfaceInstalledInputElement(input, ownedTerminal);
      await clickReleaseSurfaceInstalledInputElement(input, setup);
      await waitForTerminalState(input, terminalId, (state) => state.active === terminalId, "owned ACP terminal opposite baseline");
      targetSelector = SHELL_BUTTON;
    } else if (assignment.surface.name === CLOSE_TERMINAL) {
      targetSelector = `[data-release-terminal-id='${terminalId}'] [aria-label='close terminal tab']`;
    }
    const control = await waitForReleaseSurfaceInstalledInputElement(input, targetSelector);
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";
    if (assignment.surface.name === CLOSE_TERMINAL) {
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, ownedTerminal);
      await waitForTerminalState(input, terminalId, (state) => state.ids.length === 0 && state.active === "user", "owned terminal dismissal");
      outcome.observedEffect = "A native click dismissed exactly the owned projected ACP terminal row and returned selection to the owned tab's shell projection without touching a PTY.";
    } else {
      const expected = assignment.surface.name === SHELL ? "user" : terminalId;
      await waitForTerminalState(input, terminalId, (state) => (
        sameStrings(state.ids, [terminalId]) && state.active === expected
      ), "owned terminal selection transition");
      outcome.observedEffect = assignment.surface.name === SHELL
        ? "A native click moved the owned terminal strip selection from its projected ACP terminal back to the shell projection without spawning or controlling a PTY."
        : "A native click selected the exact owned projected ACP terminal identity while preserving the sole owned terminal row.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    applyCleanup(outcome, await cleanupOwnedLifecycle(connection, input, tab, null, baselinePrompt, {
      clearRendererFixture: true,
      expectedTerminalBaseline: baselineTerminal,
    }));
  }
  return finalize(outcome);
}

async function createOwnedTab(connection: Connection, input: InstalledInput): Promise<OwnedTab> {
  const baseline = await uiState(connection);
  const baselineTabs = exactTabs(baseline, "BottomPanel baseline");
  const baselineActiveId = exactActiveId(baseline, baselineTabs, "BottomPanel baseline");
  const baselineBottomTab = typeof baseline.bottomTab === "string" ? baseline.bottomTab : "";
  if (!baselineBottomTab) throw new Error("BottomPanel baseline did not expose its active bottom tab");
  const baselinePreview = record(baseline.preview);
  if (baselinePreview) throw new Error("BottomPanel lifecycle fixture refuses a pre-existing Preview target");
  if (await terminalMounted(input)) {
    throw new Error("BottomPanel lifecycle fixture refuses a renderer with an already-mounted baseline terminal");
  }
  const control = await waitForReleaseSurfaceInstalledInputElement(input, NEW_TAB);
  await clickReleaseSurfaceInstalledInputElement(input, control);
  const opened = await waitForUiState(connection, (state) => {
    const tabs = safeTabs(state);
    return tabs.length === baselineTabs.length + 1
      && baselineTabs.every((tab, index) => tabs[index]?.tabId === tab.tabId)
      && typeof state.activeTabId === "string"
      && state.activeTabId === tabs.at(-1)?.tabId;
  }, "owned BottomPanel tab creation");
  const openedTabs = exactTabs(opened, "owned BottomPanel tab state");
  const ownedTab = openedTabs.at(-1)!;
  const tabId = ownedTab.tabId;
  if (baselineTabs.some((tab) => tab.tabId === tabId)) throw new Error("owned BottomPanel tab reused a baseline identity");
  if (ownedTab.sessionId != null || ownedTab.title !== "new session" || ownedTab.status !== "Idle") {
    throw new Error("native new-session control did not create the expected pristine owned tab");
  }
  return { baselineTabs, baselineActiveId, baselineBottomTab, baselinePreview, tabId };
}

async function cleanupOwnedLifecycle(
  connection: Connection,
  input: InstalledInput,
  tab: OwnedTab | null,
  files: OwnedFiles | null,
  baselinePrompt: string,
  options: {
    removeAttachmentPath?: string;
    clearRendererFixture?: boolean;
    closePreview?: boolean;
    expectedTerminalBaseline?: TerminalState | null;
    clearAgentPickerFixture?: boolean;
    clearVoiceFixture?: boolean;
    turnOffVoiceMode?: boolean;
  } = {},
): Promise<string | null> {
  const errors: string[] = [];
  if (tab) {
    try {
      const current = await uiState(connection);
      if (safeTabs(current).some((entry) => entry.tabId === tab.tabId)) {
        if (current.activeTabId !== tab.tabId) {
          const owned = await waitForReleaseSurfaceInstalledInputElement(input, `[data-tab-id='${safeTabId(tab.tabId)}']`);
          await clickReleaseSurfaceInstalledInputElement(input, owned);
          await waitForUiState(connection, (state) => state.activeTabId === tab.tabId, "owned BottomPanel tab cleanup selection");
        }
        await setPrompt(input, baselinePrompt);
        if (options.turnOffVoiceMode) {
          const voiceOff = await findReleaseSurfaceInstalledInputElement(input, VOICE_OFF_BUTTON);
          if (voiceOff) {
            await clickReleaseSurfaceInstalledInputElement(input, voiceOff);
            await waitForReleaseSurfaceInstalledInputElementAbsent(input, VOICE_OFF_BUTTON);
          }
        }
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
    try {
      await postUi(connection, {
        bottomTab: tab.baselineBottomTab,
        ...(options.removeAttachmentPath ? { debugRemoveAttachmentPaths: [options.removeAttachmentPath] } : {}),
        ...(options.clearRendererFixture ? { debugRendererFixture: "clear" } : {}),
        ...(options.clearAgentPickerFixture ? { debugAgentPickerFixture: "clear" } : {}),
        ...(options.clearVoiceFixture ? { releaseTestVoiceCapture: "clear" } : {}),
        ...(options.closePreview
          ? { openModal: "close", ...(tab.baselinePreview ? { preview: tab.baselinePreview } : { clearPreview: true }) }
          : {}),
        source: "final-surface-bottom-panel-cleanup",
      });
      if (options.removeAttachmentPath) {
        await waitForReleaseSurfaceInstalledInputElementAbsent(input, attachmentSelector(options.removeAttachmentPath));
        await requireNoAttachmentChips(input, "owned attachment cleanup");
      }
      if (options.closePreview) await waitForReleaseSurfaceInstalledInputElementAbsent(input, PREVIEW_DIALOG);
      if (options.expectedTerminalBaseline) {
        await waitForReleaseSurfaceInstalledInputElementAbsent(input, `[data-release-terminal-id]`);
        await waitForTerminalMounted(input, options.expectedTerminalBaseline.mounted, "owned terminal baseline restoration");
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
    try {
      const current = await uiState(connection);
      if (safeTabs(current).some((entry) => entry.tabId === tab.tabId)) {
        const close = await waitForReleaseSurfaceInstalledInputElement(
          input,
          `[data-tab-id='${safeTabId(tab.tabId)}'] [aria-label='Close session']`,
        );
        await clickReleaseSurfaceInstalledInputElement(input, close);
      }
      const afterClose = await waitForUiState(connection, (state) => {
        const ids = safeTabs(state).map((entry) => entry.tabId);
        return sameStrings(ids, tab.baselineTabs.map((entry) => entry.tabId));
      }, "owned BottomPanel tab close");
      if (afterClose.activeTabId !== tab.baselineActiveId) {
        const baseline = await waitForReleaseSurfaceInstalledInputElement(input, `[data-tab-id='${safeTabId(tab.baselineActiveId)}']`);
        await clickReleaseSurfaceInstalledInputElement(input, baseline);
      }
      await waitForUiState(connection, (state) => (
        state.activeTabId === tab.baselineActiveId
        && sameStrings(safeTabs(state).map((entry) => entry.tabId), tab.baselineTabs.map((entry) => entry.tabId))
        && state.bottomTab === tab.baselineBottomTab
      ), "exact BottomPanel baseline restoration");
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  if (files) {
    try {
      if (existsSync(files.nodeRoot)) rmSync(files.nodeRoot, { recursive: true });
      if (existsSync(files.nodeRoot)) throw new Error("owned BottomPanel fixture root remained after deletion");
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function prepareOwnedFiles(request: ReleaseSurfaceDriverRequest): OwnedFiles {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("BottomPanel fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-bottom-panel-lifecycle");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("BottomPanel fixture escaped the disposable profile");
  }
  if (existsSync(nodeRoot)) throw new Error("BottomPanel fixture root must not pre-exist");
  try {
    mkdirSync(nodeRoot, { mode: 0o700 });
    writeFileSync(join(nodeRoot, OWNED_ATTACHMENT_NAME), "ShellX owned BottomPanel attachment\n", { flag: "wx", mode: 0o600 });
    writeFileSync(
      join(nodeRoot, OWNED_IMAGE_NAME),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (existsSync(nodeRoot)) rmSync(nodeRoot, { recursive: true });
    throw error;
  }
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-bottom-panel-lifecycle", request.platform);
  return {
    nodeRoot,
    attachmentLaunchPath: portableJoin(launchRoot, OWNED_ATTACHMENT_NAME, request.platform),
    imageLaunchPath: portableJoin(launchRoot, OWNED_IMAGE_NAME, request.platform),
  };
}

async function setPrompt(input: InstalledInput, value: string): Promise<void> {
  const prompt = await waitForReleaseSurfaceInstalledInputElement(input, PROMPT);
  await clearReleaseSurfaceInstalledInputElement(input, prompt);
  if (value) await setReleaseSurfaceInstalledInputElementValue(input, prompt, value);
  await waitForComposerState(input, (state) => state.prompt === value, "composer prompt restoration");
}

async function composerState(input: InstalledInput): Promise<ComposerState> {
  const observation = await observeReleaseSurfaceInstalledInputElement(input, PROMPT, ["value"]);
  if (!observation.present || !observation.visible || typeof observation.value !== "string") {
    throw new Error("BottomPanel composer prompt did not expose its declared bounded value observation");
  }
  return { prompt: observation.value };
}

async function waitForComposerState(
  input: InstalledInput,
  predicate: (state: ComposerState) => boolean,
  label: string,
): Promise<ComposerState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await composerState(input);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function terminalMounted(input: InstalledInput): Promise<boolean> {
  const observation = await observeReleaseSurfaceInstalledInputElement(input, ".bottom-panel", ["mounted"]);
  if (!observation.present || !observation.visible || typeof observation.mounted !== "boolean") {
    throw new Error("BottomPanel did not expose its declared bounded terminal-mounted observation");
  }
  return observation.mounted;
}

async function waitForTerminalMounted(input: InstalledInput, expected: boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await terminalMounted(input) === expected) return;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function terminalState(input: InstalledInput, terminalId: string): Promise<TerminalState> {
  const escapedId = safeTabId(terminalId);
  const rowSelector = `[data-release-terminal-id='${escapedId}']`;
  const terminalSelector = `[title='ACP terminal ${escapedId}']`;
  const foreignSelector = `[data-release-terminal-id]:not([data-release-terminal-id='${escapedId}'])`;
  // macOS target resolution uses one authenticated highlight challenge at a
  // time. Keep these reads sequential so concurrent challenges cannot replace
  // each other in the shared renderer state.
  const mounted = await terminalMounted(input);
  const row = await findReleaseSurfaceInstalledInputElement(input, rowSelector);
  const foreign = await findReleaseSurfaceInstalledInputElement(input, foreignSelector);
  const shell = await findReleaseSurfaceInstalledInputElement(input, SHELL_BUTTON);
  const terminal = await findReleaseSurfaceInstalledInputElement(input, terminalSelector);
  const fixtureUser = await findReleaseSurfaceInstalledInputElement(
    input,
    "[data-release-bottom-panel-user-terminal-fixture]",
  );
  if (foreign) throw new Error("BottomPanel terminal fixture observed a foreign ACP terminal row");
  const shellPressed = shell
    ? await observeReleaseSurfaceInstalledInputElement(input, SHELL_BUTTON, ["pressed"])
    : null;
  const terminalPressed = terminal
    ? await observeReleaseSurfaceInstalledInputElement(input, terminalSelector, ["pressed"])
    : null;
  if (shellPressed && typeof shellPressed.pressed !== "boolean") {
    throw new Error("BottomPanel shell tab omitted its bounded pressed observation");
  }
  if (terminalPressed && typeof terminalPressed.pressed !== "boolean") {
    throw new Error("BottomPanel ACP tab omitted its bounded pressed observation");
  }
  if (shellPressed?.pressed === true && terminalPressed?.pressed === true) {
    throw new Error("BottomPanel terminal fixture reported two active terminal projections");
  }
  return {
    mounted,
    ids: row ? [terminalId] : [],
    active: shellPressed?.pressed === true ? "user" : terminalPressed?.pressed === true ? terminalId : null,
    fixtureUserVisible: Boolean(fixtureUser),
  };
}

async function waitForTerminalState(
  input: InstalledInput,
  terminalId: string,
  predicate: (state: TerminalState) => boolean,
  label: string,
): Promise<TerminalState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await terminalState(input, terminalId);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

function attachmentSelector(path: string): string {
  return `.composer-attachment-chip[title=${JSON.stringify(path)}]`;
}

async function waitForExactAttachment(
  input: InstalledInput,
  selector: string,
  expectedPath: string,
  label: string,
): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(input, selector);
  const observation = await observeReleaseSurfaceInstalledInputElement(input, selector, ["title"]);
  if (!observation.present || !observation.visible || observation.title !== expectedPath) {
    throw new Error(`${label} did not expose the exact owned attachment title`);
  }
}

async function requireNoAttachmentChips(input: InstalledInput, label: string): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(input, ".composer-attachment-chip[title]")) {
    throw new Error(`${label} contained a pre-existing attachment chip`);
  }
}

async function uiState(connection: Connection): Promise<Record<string, unknown>> {
  return apiJson(connection, "GET", "/state/ui");
}

async function waitForUiState(
  connection: Connection,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", { debugSurface: "app", ...body });
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  const value = text ? JSON.parse(text) : {};
  const result = record(value);
  if (!result) throw new Error(`${method} ${path} did not return an object`);
  return result;
}

function safeTabs(state: Record<string, unknown>): UiTab[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((value) => {
    const tab = record(value);
    return tab && typeof tab.tabId === "string" && tab.tabId ? [tab as UiTab] : [];
  });
}

function exactTabs(state: Record<string, unknown>, label: string): UiTab[] {
  const tabs = safeTabs(state);
  if (!Array.isArray(state.openTabs) || tabs.length !== state.openTabs.length || tabs.length === 0) {
    throw new Error(`${label} did not expose a nonempty exact openTabs array`);
  }
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length) throw new Error(`${label} contained duplicate tab identities`);
  return tabs;
}

function exactActiveId(state: Record<string, unknown>, tabs: UiTab[], label: string): string {
  const active = typeof state.activeTabId === "string" ? state.activeTabId : "";
  if (!active || !tabs.some((tab) => tab.tabId === active)) throw new Error(`${label} did not bind activeTabId to an exact open tab`);
  return active;
}

function safeTabId(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("renderer tab identity is not safe for an exact selector");
  return value;
}

function cssAttribute(value: string): string {
  if (/['\n\r\0]/.test(value)) throw new Error("owned fixture path is not safe for an exact CSS attribute selector");
  return value.replaceAll("\\", "\\\\");
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("BottomPanel token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
    observedEffect: "No owned BottomPanel lifecycle was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (!error) outcome.cleanup = "pass";
  else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "BottomPanel lifecycle control did not satisfy every required verdict";
  }
  return outcome;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
