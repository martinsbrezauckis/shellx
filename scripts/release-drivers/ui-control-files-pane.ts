import { isDeepStrictEqual } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
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
type FilesPaneAction =
  | "attach-selected"
  | "attach-row"
  | "remove-selection"
  | "clear-selection"
  | "row-lifecycle"
  | "back"
  | "up";

type FilesPaneFixture = {
  nodeRoot: string;
  nodeSession: string;
  nodeDirectory: string;
  nodeSessionFile: string;
  nodeNestedFile: string;
  launchRoot: string;
  launchSession: string;
  launchDirectory: string;
  launchSessionFile: string;
  launchNestedFile: string;
  tabId: string;
  baselineRightTab: string;
  baselineActiveTab: Record<string, unknown>;
  baselinePreview: Record<string, unknown> | null;
};

const SESSION_FILE = "release-owned-file.txt";
const NESTED_FILE = "release-owned-nested.txt";
const DIRECTORY = "release-owned-directory";
const SESSION_CONTENT = "ShellX owned FilesPane release fixture\n";
const NESTED_CONTENT = "ShellX owned nested FilesPane release fixture\n";

const ACTION_BY_SURFACE: Record<string, FilesPaneAction> = {
  "src/components/FilesPane.tsx::is([title=\"Attach handler unavailable\"],[title=\"Attach selected files to the composer\"])": "attach-selected",
  "src/components/FilesPane.tsx:[aria-label^=\"Attach \"]": "attach-row",
  "src/components/FilesPane.tsx:[aria-label^=\"Remove \"]": "remove-selection",
  "src/components/FilesPane.tsx:[aria-label=\"Clear selected files\"]": "clear-selection",
  "src/components/FilesPane.tsx:[data-debug-id=\"surface-components-filespane-7\"]": "row-lifecycle",
  "src/components/FilesPane.tsx:[aria-label=\"Back to session folder\"]": "back",
  "src/components/FilesPane.tsx:[aria-label=\"Up one level\"]": "up",
};

const SELECT_FILE = `[aria-label='Select ${SESSION_FILE}']`;
const REMOVE_FILE = `[aria-label='Remove ${SESSION_FILE} from selection']`;
const ATTACH_SELECTED = "[title='Attach selected files to the composer']";
const CLEAR_SELECTED = "[aria-label='Clear selected files']";
const ATTACH_FILE = `[aria-label='Attach ${SESSION_FILE}']`;
const DIRECTORY_ROW = ".fv-row.dir [data-debug-id='surface-components-filespane-7']";
const FILE_ROW = ".fv-row.file [data-debug-id='surface-components-filespane-7']";
const BACK = "[title='Back to session folder']";
const UP = "[title='Up one level']";
const PREVIEW = "[role='dialog'][aria-label='Preview Center']";

export const FILES_PANE_FIXTURES = ["ui:files-pane-owned-tree"] as const;
export const FILES_PANE_CLEANUPS = [
  "ui:remove-owned-files-attachments-close-preview-delete-tree-and-restore-state",
] as const;
export const FILES_PANE_ORACLES = [
  "ui:activation:files-pane-selected-attached",
  "ui:activation:files-pane-row-attached",
  "ui:activation:files-pane-selection-removed",
  "ui:activation:files-pane-selection-cleared",
  "ui:activation:files-pane-row-navigation-preview",
  "ui:activation:files-pane-session-folder-restored",
  "ui:activation:files-pane-parent-opened",
] as const;

export function supportsFilesPaneControl(assignment: Assignment): boolean {
  return actionFor(assignment) !== null;
}

export async function exerciseFilesPaneControl(
  connection: Connection,
  webdriver: WebDriver,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = actionFor(assignment);
  const outcome = emptyOutcome(assignment);
  let fixture: FilesPaneFixture | null = null;
  try {
    if (!action) throw new Error(`FilesPane driver does not support ${assignment.surface.id}`);
    fixture = prepareFixture(request);
    await hydrateBaseline(connection, fixture);
    await postUi(connection, {
      debugSurface: "app",
      source: "final-surface-files-pane-fixture",
      openModal: "close",
      clearPreview: true,
      rightTab: "Files",
      activeTabId: fixture.tabId,
      activeTab: {
        ...fixture.baselineActiveTab,
        tabId: fixture.tabId,
        cwd: fixture.launchSession,
        connectionId: null,
        connectionLabel: "Local",
        connectionTransport: "local",
      },
      debugRemoveAttachmentPaths: [fixture.launchSessionFile, fixture.launchNestedFile],
    });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE, { timeoutMs: 10_000, pollMs: 75 });

    if (action === "attach-selected" || action === "remove-selection" || action === "clear-selection") {
      await selectSessionFile(webdriver);
    } else if (action === "back") {
      const directory = await waitForReleaseSurfaceInstalledInputElement(webdriver, DIRECTORY_ROW);
      await clickReleaseSurfaceInstalledInputElement(webdriver, directory);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, BACK);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, FILE_ROW);
    }

    outcome.present = "pass";
    if (action === "attach-selected") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, ATTACH_SELECTED);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForAttachment(webdriver, fixture.launchSessionFile);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE);
      outcome.observedEffect = "Native WebDriver input attached exactly the selected owned in-scope text file to the composer and cleared the FilesPane selection.";
    } else if (action === "attach-row") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, ATTACH_FILE);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForAttachment(webdriver, fixture.launchSessionFile);
      outcome.observedEffect = "Native WebDriver input attached exactly the owned row file to the composer without selecting it or copying any filesystem object.";
    } else if (action === "remove-selection") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, REMOVE_FILE);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, CLEAR_SELECTED);
      outcome.observedEffect = "Native WebDriver input removed exactly the owned file from the FilesPane selection without changing the file or composer.";
    } else if (action === "clear-selection") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_SELECTED);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, CLEAR_SELECTED);
      outcome.observedEffect = "Native WebDriver input cleared the exact one-file FilesPane selection without changing the file or composer.";
    } else if (action === "row-lifecycle") {
      const directory = await waitForReleaseSurfaceInstalledInputElement(webdriver, DIRECTORY_ROW);
      await clickReleaseSurfaceInstalledInputElement(webdriver, directory);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, BACK);
      const nestedFile = await waitForReleaseSurfaceInstalledInputElement(webdriver, FILE_ROW);
      await clickReleaseSurfaceInstalledInputElement(webdriver, nestedFile);
      await waitForPreview(connection, webdriver, fixture);
      outcome.observedEffect = "Native WebDriver input exercised both concrete FilesPane row branches: it opened the owned child directory, then opened read-only Preview Center for that directory's exact owned file.";
    } else if (action === "back") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, BACK);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, BACK);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE);
      outcome.observedEffect = "Native WebDriver input returned from the owned child directory to the exact session folder.";
    } else {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, UP);
      await clickReleaseSurfaceInstalledInputElement(webdriver, control);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(webdriver, BACK);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, SELECT_FILE);
      outcome.observedEffect = "Native WebDriver input opened exactly the owned session folder's parent without invoking an OS picker or external process.";
    }
    verifyOwnedTree(fixture);
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (fixture) applyCleanup(outcome, await cleanup(connection, webdriver, fixture));
  }
  return finalize(outcome);
}

function actionFor(assignment: Assignment): FilesPaneAction | null {
  return ACTION_BY_SURFACE[assignment.surface.name] ?? null;
}

function prepareFixture(request: ReleaseSurfaceDriverRequest): FilesPaneFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("FilesPane fixture requires the installed candidate's regular .shellx token");
  }
  const nodeProfile = dirname(dirname(tokenPath));
  const nodeRoot = resolve(nodeProfile, "ui-files-pane-lifecycle");
  const rel = relative(resolve(nodeProfile), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("FilesPane fixture escaped the disposable candidate profile");
  }
  if (existsSync(nodeRoot)) throw new Error("FilesPane fixture root must not pre-exist");
  const nodeSession = join(nodeRoot, "session");
  const nodeDirectory = join(nodeSession, DIRECTORY);
  mkdirSync(nodeDirectory, { recursive: true, mode: 0o700 });
  const nodeSessionFile = join(nodeSession, SESSION_FILE);
  const nodeNestedFile = join(nodeDirectory, NESTED_FILE);
  writeFileSync(nodeSessionFile, SESSION_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(nodeNestedFile, NESTED_CONTENT, { encoding: "utf8", flag: "wx", mode: 0o600 });

  const launchProfile = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRoot = portableJoin(launchProfile, "ui-files-pane-lifecycle", request.platform);
  const launchSession = portableJoin(launchRoot, "session", request.platform);
  const launchDirectory = portableJoin(launchSession, DIRECTORY, request.platform);
  return {
    nodeRoot,
    nodeSession,
    nodeDirectory,
    nodeSessionFile,
    nodeNestedFile,
    launchRoot,
    launchSession,
    launchDirectory,
    launchSessionFile: portableJoin(launchSession, SESSION_FILE, request.platform),
    launchNestedFile: portableJoin(launchDirectory, NESTED_FILE, request.platform),
    tabId: "",
    baselineRightTab: "",
    baselineActiveTab: {},
    baselinePreview: null,
  };
}

async function hydrateBaseline(connection: Connection, fixture: FilesPaneFixture): Promise<void> {
  const state = await apiJson(connection, "GET", "/state/ui");
  fixture.baselineActiveTab = requiredRecord(state.activeTab, "FilesPane baseline activeTab");
  fixture.tabId = typeof state.activeTabId === "string" && state.activeTabId
    ? state.activeTabId
    : typeof fixture.baselineActiveTab.tabId === "string" ? fixture.baselineActiveTab.tabId : "";
  fixture.baselineRightTab = typeof state.rightTab === "string" ? state.rightTab : "";
  fixture.baselinePreview = optionalRecord(state.preview, "FilesPane baseline preview");
  if (!fixture.tabId || fixture.baselineActiveTab.tabId !== fixture.tabId || !fixture.baselineRightTab) {
    throw new Error("FilesPane fixture requires one exact active tab and restorable right rail");
  }
}

async function selectSessionFile(webdriver: WebDriver): Promise<void> {
  const select = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECT_FILE);
  await clickReleaseSurfaceInstalledInputElement(webdriver, select);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, REMOVE_FILE);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, CLEAR_SELECTED);
}

async function waitForAttachment(webdriver: WebDriver, path: string): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(webdriver, attachmentSelector(path), {
    timeoutMs: 10_000,
    pollMs: 75,
  });
}

async function waitForPreview(
  connection: Connection,
  webdriver: WebDriver,
  fixture: FilesPaneFixture,
): Promise<void> {
  await waitForReleaseSurfaceInstalledInputElement(webdriver, PREVIEW, { timeoutMs: 10_000, pollMs: 75 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const preview = optionalRecord(state.preview, "FilesPane preview state");
    if (preview?.kind === "file" && preview.path === fixture.launchNestedFile
      && preview.tabId === fixture.tabId && preview.sessionCwd === fixture.launchSession) return;
    await delay(75);
  }
  throw new Error("FilesPane row did not open the exact owned nested-file preview context");
}

function verifyOwnedTree(fixture: FilesPaneFixture): void {
  if (readFileSync(fixture.nodeSessionFile, "utf8") !== SESSION_CONTENT
    || readFileSync(fixture.nodeNestedFile, "utf8") !== NESTED_CONTENT
    || JSON.stringify(readdirSync(fixture.nodeRoot).sort()) !== JSON.stringify(["session"])
    || JSON.stringify(readdirSync(fixture.nodeSession).sort()) !== JSON.stringify([DIRECTORY, SESSION_FILE].sort())
    || JSON.stringify(readdirSync(fixture.nodeDirectory).sort()) !== JSON.stringify([NESTED_FILE])) {
    throw new Error("FilesPane control changed the exact owned filesystem tree");
  }
}

async function cleanup(
  connection: Connection,
  webdriver: WebDriver,
  fixture: FilesPaneFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    await postUi(connection, {
      debugSurface: "app",
      source: "final-surface-files-pane-cleanup",
      openModal: "close",
      rightTab: fixture.baselineRightTab,
      activeTabId: fixture.tabId,
      activeTab: fixture.baselineActiveTab,
      debugRemoveAttachmentPaths: [fixture.launchSessionFile, fixture.launchNestedFile],
      ...(fixture.baselinePreview ? { preview: fixture.baselinePreview } : { clearPreview: true }),
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, attachmentSelector(fixture.launchSessionFile), {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, attachmentSelector(fixture.launchNestedFile), {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    if (!fixture.baselinePreview) {
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, PREVIEW, { timeoutMs: 5_000, pollMs: 50 });
    }
    const restored = await apiJson(connection, "GET", "/state/ui");
    const restoredActive = requiredRecord(restored.activeTab, "restored FilesPane activeTab");
    const restoredPreview = optionalRecord(restored.preview, "restored FilesPane preview");
    if (restored.rightTab !== fixture.baselineRightTab
      || !isDeepStrictEqual(restoredActive, fixture.baselineActiveTab)
      || !isDeepStrictEqual(restoredPreview, fixture.baselinePreview)) {
      throw new Error("FilesPane cleanup did not restore the exact active-tab, right-rail, and preview baseline");
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    verifyOwnedTree(fixture);
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned FilesPane fixture root remained");
  } catch (error) {
    errors.push(errorText(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function attachmentSelector(path: string): string {
  return `.composer-attachment-chip[title=${JSON.stringify(path)}]`;
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  const index = normalized.lastIndexOf("\\");
  if (index <= 2) throw new Error("FilesPane token path is outside a disposable Windows profile");
  return normalized.slice(0, index);
}

function portableJoin(base: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed" ? `${base.replace(/[\\/]+$/, "")}\\${child}` : join(base, child);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return requiredRecord(value, label);
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
    observedEffect: "No deterministic native FilesPane lifecycle transition was observed.",
  };
}

function applyCleanup(outcome: ReleaseSurfaceDriverOutcome, error: string | null): void {
  if (error) outcome.error = outcome.error ? `${outcome.error}; cleanup: ${error}` : `cleanup: ${error}`;
  else outcome.cleanup = "pass";
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "FilesPane control did not satisfy every required verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
