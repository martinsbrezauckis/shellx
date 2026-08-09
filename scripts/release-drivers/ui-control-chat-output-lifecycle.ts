import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
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
type UiState = {
  activeTabId: string | null;
  activeTab: Record<string, unknown> | null;
  bottomTab: string | null;
  rightTab: string | null;
  openModal: string | null;
  preview: Record<string, unknown> | null;
};
type OwnedPreviewFiles = {
  nodeRoot: string;
  launchRoot: string;
  launchAttachmentPath: string;
  launchDiffPath: string;
};

const JUMP = "[data-debug-id='surface-components-chatoutput-1']";
const ATTACHMENT = "[data-debug-id='surface-components-chatoutput-3']";
const DIFF = "[data-debug-id='surface-components-chatoutput-4']";
const THOUGHT = "[data-debug-id='surface-components-chatoutput-5']";
const DOOM_WARNING = "[aria-label^='Dismiss warning: ']";
const HOST_WARNING = "[aria-label='Dismiss host MCP unreachable warning']";
const OUTPUT = ".output";
const PREVIEW_DIALOG = "[role='dialog'][aria-label='Preview Center']";
const PREVIEW_CLOSE = `${PREVIEW_DIALOG} [aria-label='Close']`;
const PREVIEW_HEADING = ".preview-center-heading";
const PREVIEW_RECEIPT = ".preview-modal.preview-modal-embedded";
const ATTACHMENT_NAME = "release-chat-output-attachment.txt";
const DIFF_NAME = "release-chat-output-diff.ts";
const ATTACHMENT_CONTENT = "SHELLX_RELEASE_CHAT_OUTPUT_ATTACHMENT_035";
const DIFF_CONTENT = "export const shellxReleaseChatOutputPreview = true;";
const exactSelectors = [JUMP, ATTACHMENT, DIFF, THOUGHT, DOOM_WARNING, HOST_WARNING] as const;

export const CHAT_OUTPUT_LIFECYCLE_FIXTURES = ["ui:chat-output-owned-renderer-lifecycle"] as const;
export const CHAT_OUTPUT_LIFECYCLE_CLEANUPS = ["ui:clear-owned-chat-output-events-close-preview-delete-files-and-restore-view"] as const;
export const CHAT_OUTPUT_LIFECYCLE_ORACLES = [
  "ui:activation:chat-output-jump-repinned",
  "ui:activation:chat-output-owned-attachment-preview",
  "ui:activation:chat-output-owned-diff-preview",
  "ui:disclosure-state-transition",
  "ui:activation:chat-output-owned-doom-warning-dismissed",
  "ui:activation:chat-output-owned-host-warning-dismissed",
] as const;
export const CHAT_OUTPUT_JUMP_DEBUG_FIXTURES = ["ui:chat-output-owned-native-scroll-marker"] as const;
export const CHAT_OUTPUT_JUMP_DEBUG_CLEANUPS = ["ui:clear-owned-chat-output-scroll-marker-and-restore-view"] as const;
export const CHAT_OUTPUT_JUMP_DEBUG_ORACLES = ["ui:visible-native-scroll-marker-rectangle"] as const;

export function supportsChatOutputLifecycleControl(assignment: Assignment): boolean {
  return assignment.surface.source === "src/components/ChatOutput.tsx"
    && exactSelectors.includes(normalizeSelector(assignment.surface.selector ?? "") as typeof exactSelectors[number]);
}

export async function exerciseChatOutputLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [
    normalizeSelector(assignment.surface.selector!),
    emptyOutcome(assignment),
  ]));
  const outcome = (selector: string): ReleaseSurfaceDriverOutcome => {
    const value = outcomes.get(selector);
    if (!value) throw new Error(`ChatOutput outcome is missing ${selector}`);
    return value;
  };
  const markPresent = (selector: string): void => { outcome(selector).present = "pass"; };
  const markInvoke = (selector: string): void => { outcome(selector).invoke = "pass"; };
  const markEffect = (selector: string, detail: string): void => {
    outcome(selector).effect = "pass";
    outcome(selector).observedEffect = detail;
  };

  let baseline: UiState | null = null;
  let files: OwnedPreviewFiles | null = null;
  let fixtureApplied = false;
  let primaryError: string | null = null;
  try {
    baseline = await readUiState(connection);
    if (!baseline.activeTabId || !baseline.activeTab || !baseline.bottomTab || !baseline.rightTab) {
      throw new Error("ChatOutput fixture requires exact active-tab, bottom-tab, and right-tab baselines");
    }
    if (baseline.openModal !== null || baseline.preview !== null) {
      throw new Error("ChatOutput fixture requires an empty modal and file-preview baseline");
    }
    files = prepareOwnedPreviewFiles(request);
    if (baseline.bottomTab !== "Chat") await postUi(connection, { bottomTab: "Chat" });
    for (const selector of exactSelectors) {
      if (await findReleaseSurfaceInstalledInputElement(installedInput, selector)) {
        throw new Error(`ChatOutput owned fixture requires absent baseline control ${selector}`);
      }
    }

    fixtureApplied = true;
    await postUi(connection, {
      activeTabId: baseline.activeTabId,
      activeTab: { ...baseline.activeTab, cwd: files.launchRoot },
      debugRendererFixture: {
        id: "chat-output-lifecycle",
        attachmentPath: files.launchAttachmentPath,
        diffPath: files.launchDiffPath,
      },
    });

    const thought = await waitForReleaseSurfaceInstalledInputElement(installedInput, THOUGHT);
    markPresent(THOUGHT);
    await requireExpanded(installedInput, THOUGHT, false, "owned thought baseline");
    await clickReleaseSurfaceInstalledInputElement(installedInput, thought);
    markInvoke(THOUGHT);
    await waitForExpanded(installedInput, THOUGHT, true);
    const collapse = await waitForReleaseSurfaceInstalledInputElement(installedInput, THOUGHT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, collapse);
    await waitForExpanded(installedInput, THOUGHT, false);
    markEffect(THOUGHT, "The owned thought disclosure expanded and returned to its exact collapsed renderer state.");

    const output = await waitForReleaseSurfaceInstalledInputElement(installedInput, OUTPUT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, output);
    const jump = await revealJumpControl(installedInput);
    markPresent(JUMP);
    await clickReleaseSurfaceInstalledInputElement(installedInput, jump);
    markInvoke(JUMP);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, JUMP);
    markEffect(JUMP, "The native Jump to latest click re-pinned the owned transcript and removed its unpinned affordance.");

    await exercisePreviewControl(
      connection,
      installedInput,
      outcome(ATTACHMENT),
      ATTACHMENT,
      files.launchAttachmentPath,
      files.launchRoot,
      baseline.activeTabId,
      ATTACHMENT_NAME,
      "text",
      ATTACHMENT_CONTENT.length,
    );
    markEffect(ATTACHMENT, "The native attachment-chip click opened Preview Center, read the exact owned text file, and preserved its exact candidate-profile path and source-tab context.");

    await exercisePreviewControl(
      connection,
      installedInput,
      outcome(DIFF),
      DIFF,
      files.launchDiffPath,
      files.launchRoot,
      baseline.activeTabId,
      DIFF_NAME,
      "code",
      DIFF_CONTENT.length,
    );
    markEffect(DIFF, "The native diff-path click opened Preview Center, read the exact owned TypeScript file, and preserved its exact candidate-profile path and source-tab context.");

    const doom = await waitForReleaseSurfaceInstalledInputElement(installedInput, DOOM_WARNING);
    markPresent(DOOM_WARNING);
    await clickReleaseSurfaceInstalledInputElement(installedInput, doom);
    markInvoke(DOOM_WARNING);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DOOM_WARNING);
    markEffect(DOOM_WARNING, "The native dismissal removed only the owned renderer-loop warning.");

    const host = await waitForReleaseSurfaceInstalledInputElement(installedInput, HOST_WARNING);
    markPresent(HOST_WARNING);
    await clickReleaseSurfaceInstalledInputElement(installedInput, host);
    markInvoke(HOST_WARNING);
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, HOST_WARNING);
    markEffect(HOST_WARNING, "The native dismissal removed only the owned renderer host-MCP warning.");
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (fixtureApplied) {
      try {
        await postUi(connection, {
          debugRendererFixture: { id: "chat-output-lifecycle", action: "clear" },
          openModal: "close",
          clearPreview: true,
        });
        for (const selector of exactSelectors) {
          await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, selector);
        }
      } catch (error) {
        cleanupErrors.push(`owned renderer fixture: ${errorMessage(error)}`);
      }
    }
    if (baseline) {
      try {
        await postUi(connection, {
          openModal: "close",
          clearPreview: true,
          bottomTab: baseline.bottomTab,
          rightTab: baseline.rightTab,
          activeTabId: baseline.activeTabId,
          activeTab: baseline.activeTab,
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, PREVIEW_DIALOG);
        const restored = await readUiState(connection);
        if (restored.activeTabId !== baseline.activeTabId
          || restored.bottomTab !== baseline.bottomTab
          || restored.rightTab !== baseline.rightTab
          || restored.openModal !== null
          || restored.preview !== null
          || JSON.stringify(restored.activeTab) !== JSON.stringify(baseline.activeTab)) {
          throw new Error("ChatOutput cleanup did not restore exact active-tab, view, modal, and preview baselines");
        }
      } catch (error) {
        cleanupErrors.push(`view baseline: ${errorMessage(error)}`);
      }
    }
    if (files) {
      try {
        rmSync(files.nodeRoot, { recursive: true });
        if (existsSync(files.nodeRoot)) throw new Error("owned ChatOutput preview root remained");
      } catch (error) {
        cleanupErrors.push(`owned preview files: ${errorMessage(error)}`);
      }
    }
    const cleanupError = cleanupErrors.join("; ");
    for (const value of outcomes.values()) {
      if (!cleanupError) value.cleanup = "pass";
      if (primaryError && !value.error) value.error = primaryError;
      if (cleanupError) value.error = appendError(value.error, `cleanup: ${cleanupError}`);
      if ([value.present, value.invoke, value.effect, value.cleanup].includes("fail") && !value.error) {
        value.error = "ChatOutput lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => outcome(normalizeSelector(assignment.surface.selector!)));
}

export function supportsChatOutputJumpDebugSurface(assignment: Assignment): boolean {
  return assignment.surface.kind === "ui-debug-surface"
    && assignment.surface.source === "src/components/ChatOutput.tsx"
    && assignment.surface.name === "surface-components-chatoutput-1"
    && normalizeSelector(assignment.surface.selector ?? "") === JUMP;
}

export async function exerciseChatOutputJumpDebugSurface(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const result = emptyOutcome(assignment);
  result.observedEffect = "No native-scroll ChatOutput marker effect was observed.";
  const highlightId = "final-surface-chat-output-native-scroll-marker";
  let baseline: UiState | null = null;
  let fixtureApplied = false;
  let primaryError: string | null = null;
  try {
    if (!supportsChatOutputJumpDebugSurface(assignment)
      || assignment.fixtureId !== CHAT_OUTPUT_JUMP_DEBUG_FIXTURES[0]
      || assignment.cleanupId !== CHAT_OUTPUT_JUMP_DEBUG_CLEANUPS[0]
      || assignment.oracleId !== CHAT_OUTPUT_JUMP_DEBUG_ORACLES[0]) {
      throw new Error("ChatOutput Jump debug assignment does not match its native-scroll lifecycle");
    }
    baseline = await readUiState(connection);
    if (!baseline.activeTabId || !baseline.activeTab || !baseline.bottomTab || !baseline.rightTab
      || baseline.openModal !== null || baseline.preview !== null) {
      throw new Error("ChatOutput Jump marker requires a quiescent restorable UI baseline");
    }
    if (await findReleaseSurfaceInstalledInputElement(installedInput, JUMP)) {
      throw new Error("ChatOutput Jump marker requires an absent baseline");
    }
    if (baseline.bottomTab !== "Chat") await postUi(connection, { bottomTab: "Chat" });
    fixtureApplied = true;
    await postUi(connection, { debugRendererFixture: { id: "chat-output-lifecycle" } });
    const output = await waitForReleaseSurfaceInstalledInputElement(installedInput, OUTPUT);
    await clickReleaseSurfaceInstalledInputElement(installedInput, output);
    await revealJumpControl(installedInput);
    result.present = "pass";
    await postUi(connection, {
      debugHighlights: [{
        id: highlightId,
        selector: JUMP,
        label: assignment.surface.name,
        color: "cyan",
      }],
    });
    result.invoke = "pass";
    const highlight = await waitForResolvedHighlight(connection, highlightId);
    const rect = highlight.visibleRect ?? highlight.rect;
    if (!rect || Number(rect.width) <= 0 || Number(rect.height) <= 0) {
      throw new Error("ChatOutput Jump highlight resolved without a non-empty visible rectangle");
    }
    result.effect = "pass";
    result.observedEffect = `Native upward input exposed the genuine Jump to latest marker, whose exact selector resolved to a visible ${Number(rect.width)}x${Number(rect.height)} rectangle.`;
  } catch (error) {
    primaryError = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await postUi(connection, { debugHighlights: [] });
      await waitForHighlightAbsent(connection, highlightId);
    } catch (error) {
      cleanupErrors.push(`highlight: ${errorMessage(error)}`);
    }
    if (fixtureApplied) {
      try {
        await postUi(connection, { debugRendererFixture: { id: "chat-output-lifecycle", action: "clear" } });
        await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, JUMP);
      } catch (error) {
        cleanupErrors.push(`owned renderer fixture: ${errorMessage(error)}`);
      }
    }
    if (baseline) {
      try {
        await postUi(connection, {
          bottomTab: baseline.bottomTab,
          rightTab: baseline.rightTab,
          activeTabId: baseline.activeTabId,
          activeTab: baseline.activeTab,
        });
        const restored = await readUiState(connection);
        if (restored.activeTabId !== baseline.activeTabId
          || restored.bottomTab !== baseline.bottomTab
          || restored.rightTab !== baseline.rightTab
          || JSON.stringify(restored.activeTab) !== JSON.stringify(baseline.activeTab)) {
          throw new Error("ChatOutput Jump marker cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        cleanupErrors.push(`view baseline: ${errorMessage(error)}`);
      }
    }
    if (cleanupErrors.length === 0) result.cleanup = "pass";
    if (primaryError) result.error = primaryError;
    if (cleanupErrors.length > 0) result.error = appendError(result.error, `cleanup: ${cleanupErrors.join("; ")}`);
    if ([result.present, result.invoke, result.effect, result.cleanup].includes("fail") && !result.error) {
      result.error = "ChatOutput Jump debug lifecycle did not satisfy every required verdict";
    }
  }
  return result;
}

async function revealJumpControl(
  installedInput: ReleaseSurfaceInstalledInputSession,
) {
  const key = installedInput.transport === "native-webdriver" ? "\uE013" : "up";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const existing = await findReleaseSurfaceInstalledInputElement(installedInput, JUMP);
    if (existing) return existing;
    await performReleaseSurfaceInstalledInputKeyChord(installedInput, [key]);
    await delay(80);
  }
  throw new Error("owned ChatOutput transcript did not expose Jump to latest after bounded native upward scrolling");
}

async function exercisePreviewControl(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  outcome: ReleaseSurfaceDriverOutcome,
  selector: string,
  expectedPath: string,
  expectedRoot: string,
  expectedTabId: string,
  expectedName: string,
  expectedKind: "text" | "code",
  expectedCharacters: number,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  outcome.invoke = "pass";
  await waitForReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_DIALOG);
  await waitForExactPreviewState(connection, expectedPath, expectedRoot, expectedTabId);
  await waitForObservedTitle(installedInput, PREVIEW_HEADING, expectedPath, "Preview Center heading");
  await waitForObservedTitle(
    installedInput,
    PREVIEW_RECEIPT,
    `File preview ready · ${expectedName} · ${expectedKind} · ${expectedCharacters} characters`,
    "File Preview read receipt",
  );
  const close = await waitForReleaseSurfaceInstalledInputElement(installedInput, PREVIEW_CLOSE);
  await clickReleaseSurfaceInstalledInputElement(installedInput, close);
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, PREVIEW_DIALOG);
}

async function waitForExactPreviewState(
  connection: Connection,
  expectedPath: string,
  expectedRoot: string,
  expectedTabId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readUiState(connection);
    const preview = state.preview;
    if (preview?.kind === "file"
      && preview.path === expectedPath
      && preview.tabId === expectedTabId
      && preview.sessionCwd === expectedRoot) return;
    await delay(50);
  }
  throw new Error(`Preview Center did not bind the exact owned path ${expectedPath}`);
}

async function waitForObservedTitle(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["title"]);
    last = observed.title;
    if (observed.present && observed.visible && last === expected) return;
    await delay(50);
  }
  throw new Error(`${label} did not reach exact title ${expected}; last=${last ?? "missing"}`);
}

type HighlightResult = {
  id?: string;
  status?: string;
  rect?: { width?: number; height?: number } | null;
  visibleRect?: { width?: number; height?: number } | null;
  message?: string | null;
};

async function readHighlightResults(connection: Connection): Promise<HighlightResult[]> {
  const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const bySurface = isRecord(state.debugHighlightResultsBySurface)
    ? state.debugHighlightResultsBySurface.app
    : undefined;
  const rows = Array.isArray(bySurface) ? bySurface : state.debugHighlightResults;
  return Array.isArray(rows) ? rows.filter(isRecord) as HighlightResult[] : [];
}

async function waitForResolvedHighlight(connection: Connection, id: string): Promise<HighlightResult> {
  const deadline = Date.now() + 20_000;
  let last: HighlightResult | undefined;
  while (Date.now() < deadline) {
    last = (await readHighlightResults(connection)).find((entry) => entry.id === id);
    if (last?.status === "resolved") return last;
    if (last?.status && last.status !== "pending" && last.status !== "missing") {
      throw new Error(last.message || `ChatOutput Jump highlight reported ${last.status}`);
    }
    await delay(100);
  }
  throw new Error(last?.message || "ChatOutput Jump highlight did not resolve");
}

async function waitForHighlightAbsent(connection: Connection, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await readHighlightResults(connection)).some((entry) => entry.id === id)) return;
    await delay(50);
  }
  throw new Error("ChatOutput Jump highlight remained after cleanup");
}

async function requireExpanded(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: boolean,
  label: string,
): Promise<void> {
  const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["expanded"]);
  if (value.expanded !== expected) throw new Error(`${label} omitted expanded=${expected}`);
}

async function waitForExpanded(
  installedInput: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["expanded"]);
    if (value.expanded === expected) return;
    await delay(50);
  }
  throw new Error(`owned ChatOutput disclosure did not reach expanded=${expected}`);
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== exactSelectors.length) {
    throw new Error(`ChatOutput lifecycle requires exactly ${exactSelectors.length} assignments`);
  }
  const selectors = new Set(assignments.map((assignment) => normalizeSelector(assignment.surface.selector ?? "")));
  for (const assignment of assignments) {
    if (!supportsChatOutputLifecycleControl(assignment)
      || assignment.fixtureId !== CHAT_OUTPUT_LIFECYCLE_FIXTURES[0]
      || assignment.cleanupId !== CHAT_OUTPUT_LIFECYCLE_CLEANUPS[0]) {
      throw new Error(`ChatOutput lifecycle assignment does not match ${assignment.surface.name}`);
    }
  }
  for (const selector of exactSelectors) {
    if (!selectors.has(selector)) throw new Error(`ChatOutput lifecycle is missing ${selector}`);
  }
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
    observedEffect: "No native owned ChatOutput lifecycle effect was observed.",
  };
}

async function readUiState(connection: Connection): Promise<UiState> {
  const value = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    activeTab: isRecord(value.activeTab) ? structuredClone(value.activeTab) : null,
    bottomTab: typeof value.bottomTab === "string" ? value.bottomTab : null,
    rightTab: typeof value.rightTab === "string" ? value.rightTab : null,
    openModal: typeof value.openModal === "string" ? value.openModal : null,
    preview: isRecord(value.preview) ? structuredClone(value.preview) : null,
  };
}

function prepareOwnedPreviewFiles(request: ReleaseSurfaceDriverRequest): OwnedPreviewFiles {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("ChatOutput preview fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfileRoot, "ui-chat-output-preview-lifecycle");
  const rel = relative(resolve(nodeProfileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("ChatOutput preview fixture escaped the disposable candidate profile");
  }
  if (existsSync(nodeRoot)) throw new Error("ChatOutput preview fixture root must not pre-exist");
  mkdirSync(nodeRoot, { mode: 0o700 });
  try {
    writeFileSync(join(nodeRoot, ATTACHMENT_NAME), ATTACHMENT_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(join(nodeRoot, DIFF_NAME), DIFF_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(nodeRoot, { recursive: true, force: true });
    throw error;
  }
  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfileRoot, "ui-chat-output-preview-lifecycle", request.platform);
  return {
    nodeRoot,
    launchRoot,
    launchAttachmentPath: portableJoin(launchRoot, ATTACHMENT_NAME, request.platform),
    launchDiffPath: portableJoin(launchRoot, DIFF_NAME, request.platform),
  };
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("ChatOutput token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function postUi(connection: Connection, patch: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-chat-output-lifecycle",
    ...patch,
  });
  await delay(150);
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function normalizeSelector(value: string): string {
  return value.replaceAll('"', "'");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
