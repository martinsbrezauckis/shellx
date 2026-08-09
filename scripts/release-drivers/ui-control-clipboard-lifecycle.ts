import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import {
  buildActivityClipboardSummary,
  combineActivityTraces,
  parseGrokUpdatesJsonl,
  parseHunkRecordsJsonl,
  summarizeActivity,
} from "../../src/lib/session-activity";
import {
  OWNED_CHAT_CLIPBOARD_CODE,
} from "../../src/lib/debug-renderer-fixture";
import {
  debugRightRailGitLifecycleFixture,
} from "../../src/lib/debug-right-rail-git-fixture";
import {
  OWNED_AGENT_CLI_CLIPBOARD_COMMAND,
} from "../../src/lib/debug-agent-cli-setup-fixture";
import {
  OWNED_DEBUG_VAULT_PASSWORD,
} from "../../src/lib/vault-password-generator";
import {
  buildOwnedClipboardPreviewDiagnostic,
  formatPreviewDoctorReport,
  type WorkPreviewState,
} from "../../src/lib/work-preview";
import {
  OWNED_CLIPBOARD_TASK,
  OWNED_CLIPBOARD_TASK_OUTPUT,
  buildTasksReport,
} from "../../src/components/TasksPanel";
import { AUTHOR_EMAIL } from "../../src/lib/about";
import { OWNED_DEBUG_TOKEN } from "../../src/components/settings/ShellxagentTab";
import { OWNED_DEBUG_VAULT_RECOVERY_WORDS } from "../../src/components/settings/VaultSetupPanel";
import {
  OWNED_DEBUG_VAULT_SECRET_KEY,
  OWNED_DEBUG_VAULT_SECRET_VALUE,
} from "../../src/lib/debug-vault-clipboard-fixture";
import {
  buildGrokEnvironmentReport,
  type GrokEnvironmentSnapshot,
} from "../../src/components/RightRail";
import {
  cleanupActivityClipboardLifecycle,
  prepareActivityClipboardLifecycle,
  type ActivityClipboardLifecycleContext,
} from "./ui-control-activity-browser-lifecycle";
import {
  WORK_PREVIEW_CENTER_CLOSE,
  WORK_PREVIEW_CENTER_DIALOG,
  WORK_PREVIEW_START_SELECTOR,
  cleanupFixture as cleanupWorkPreviewFixture,
  hydrateFixtureBaseline,
  nodeReadablePath,
  postUi as postWorkPreviewUi,
  prepareFixture as prepareWorkPreviewFixture,
  verifyRunningState,
  waitForRunningState,
  type PreviewFixture,
} from "./ui-control-work-preview-start";
import {
  abandonClipboardLifecycle,
  preflightClipboardLifecycle,
  releaseUnusedClipboardLifecycle,
  verifyAndClearClipboardLifecycle,
  type ClipboardLifecycleLease,
} from "./clipboard-lifecycle-client";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type PreparedControl = {
  selector: string;
  expectedValue: string;
  cleanup: () => Promise<void>;
};

const SETTINGS = "[role='dialog'][aria-label='Settings']";
const PREVIEW_CENTER = "[role='dialog'][aria-label='Preview Center']";
const ACTIVITY = "[role='dialog'][aria-label='Activity Browser']";
const AGENT_SETUP = "[data-debug-id='agent-cli-setup-dialog']";
const BUILTIN_DOC_CODE = '/build "build a TODO CLI in Rust with tests"\n';
const VAULT_DRAFT_VALUE = "Sx035-owned-vault-draft!";

const ids = {
  browser: 'ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-copy-address"]@src/browser/components/BrowserChrome.tsx#16',
  activity: 'ui-control:src/components/ActivityBrowserModal.tsx:[id="activity-copy-summary"]@src/components/ActivityBrowserModal.tsx#11',
  agentCard: 'ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#4',
  agentConfirm: 'ui-control:src/components/AgentCliSetupAssistant.tsx:role=button;name="Copy command"@src/components/AgentCliSetupAssistant.tsx#7',
  builtin: 'ui-control:src/components/BuiltinDocModal.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])@src/components/BuiltinDocModal.tsx#4',
  chat: 'ui-control:src/components/ChatOutput.tsx::is([aria-label="Copied"],[aria-label="Copy to clipboard"])@src/components/ChatOutput.tsx#2',
  filePath: 'ui-control:src/components/FilePreviewModal.tsx:[title="Copy absolute path to clipboard"]@src/components/FilePreviewModal.tsx#5',
  fileMention: 'ui-control:src/components/FilePreviewModal.tsx:[title="Copies `@<path>` to clipboard. Paste into the composer to mention the file in your next prompt."]@src/components/FilePreviewModal.tsx#6',
  diagnostic: 'ui-control:src/components/RightRail.tsx:[title="Copy environment diagnostic report"]@src/components/RightRail.tsx#6',
  tasksReport: 'ui-control:src/components/TasksPanel.tsx:[aria-label="Copy a compact report for visible tasks"]@src/components/TasksPanel.tsx#1',
  tasksOutput: 'ui-control:src/components/TasksPanel.tsx:[title="Copy this task\'s latest output"]@src/components/TasksPanel.tsx#10',
  vaultDraft: 'ui-control:src/components/settings/VaultTab.tsx:[aria-label="Copy without revealing"]@src/components/settings/VaultTab.tsx#27',
  vaultRecovery: 'ui-control:src/components/settings/VaultSetupPanel.tsx:[data-debug-id="shellx-vault-recovery-copy"]@src/components/settings/VaultSetupPanel.tsx#22',
  vaultRawValue: 'ui-control:src/components/settings/VaultTab.tsx:[aria-label^="Copy value for "]@src/components/settings/VaultTab.tsx#8',
  password: 'ui-control:src/components/VaultPasswordGenerator.tsx:[data-debug-id="vault-password-generator-copy"]@src/components/VaultPasswordGenerator.tsx#4',
  workDoctor: 'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-copy-doctor-report"]@src/components/WorkPreviewPanel.tsx#12',
  workPanelUrl: 'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-panel-copy-url"]@src/components/WorkPreviewPanel.tsx#13',
  workStageUrl: 'ui-control:src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-copy-url"]@src/components/WorkPreviewPanel.tsx#22',
  about: 'ui-control:src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-3"]@src/components/settings/AboutTab.tsx#3',
  shellxagent: 'ui-control:src/components/settings/ShellxagentTab.tsx:[data-debug-id="surface-components-settings-shellxagenttab-2"]@src/components/settings/ShellxagentTab.tsx#2',
} as const;

export const CLIPBOARD_LIFECYCLE_SURFACE_IDS = new Set<string>(Object.values(ids));
export const CLIPBOARD_LIFECYCLE_FIXTURES = ["ui:owned-native-clipboard-empty-lifecycle"] as const;
export const CLIPBOARD_LIFECYCLE_CLEANUPS = ["ui:clear-owned-clipboard-prove-empty-and-restore-surface"] as const;
export const CLIPBOARD_LIFECYCLE_ORACLES = ["ui:activation:native-clipboard-owned-value-verified-and-cleared"] as const;

export function supportsClipboardLifecycleControl(assignment: Assignment): boolean {
  return CLIPBOARD_LIFECYCLE_SURFACE_IDS.has(assignment.surface.id);
}

export async function exerciseClipboardLifecycleControl(
  connection: Connection,
  installedInput: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned native clipboard lifecycle was observed.",
  };
  let prepared: PreparedControl | null = null;
  let lease: ClipboardLifecycleLease | null = null;
  let invoked = false;
  let clipboardCleared = false;
  const cleanupErrors: string[] = [];
  try {
    if (!supportsClipboardLifecycleControl(assignment)) {
      throw new Error(`clipboard lifecycle driver does not support ${assignment.surface.id}`);
    }
    if (assignment.fixtureId !== CLIPBOARD_LIFECYCLE_FIXTURES[0]
      || assignment.cleanupId !== CLIPBOARD_LIFECYCLE_CLEANUPS[0]) {
      throw new Error("clipboard lifecycle assignment omitted its exact fixture or cleanup");
    }
    prepared = await prepareControl(connection, installedInput, request, assignment.surface.id);
    lease = await preflightClipboardLifecycle(connection, prepared.expectedValue);
    const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, prepared.selector, {
      timeoutMs: 10_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(installedInput, control);
    invoked = true;
    outcome.invoke = "pass";
    await verifyAndClearClipboardLifecycle(connection, lease);
    clipboardCleared = true;
    outcome.effect = "pass";
    outcome.observedEffect = "Native installed input invoked the exact owned copy control; the native host matched only SHA-256 plus UTF-8 length, cleared that same value, and proved the clipboard empty without reporting contents.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (lease && !clipboardCleared && !invoked) {
      try {
        await releaseUnusedClipboardLifecycle(connection, lease);
        clipboardCleared = true;
      } catch (error) {
        cleanupErrors.push(`unused lease: ${errorText(error)}`);
      }
    }
    if (lease && !clipboardCleared && invoked) {
      try {
        await abandonClipboardLifecycle(connection, lease);
      } catch (error) {
        cleanupErrors.push(`abandon lease: ${errorText(error)}`);
      }
    }
    if (prepared) {
      try {
        await prepared.cleanup();
      } catch (error) {
        cleanupErrors.push(`surface: ${errorText(error)}`);
      }
    }
    if (clipboardCleared && cleanupErrors.length === 0) outcome.cleanup = "pass";
    if (cleanupErrors.length > 0) {
      outcome.error = appendError(outcome.error, `cleanup: ${cleanupErrors.join("; ")}`);
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "clipboard lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function prepareControl(
  connection: Connection,
  installedInput: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  id: string,
): Promise<PreparedControl> {
  if (id === ids.browser) return prepareBrowser(connection, installedInput);
  if (id === ids.activity) return prepareActivity(connection, installedInput, request);
  if (id === ids.agentCard || id === ids.agentConfirm) return prepareAgent(connection, installedInput, id === ids.agentConfirm);
  if (id === ids.builtin) return prepareBuiltinDoc(connection, installedInput);
  if (id === ids.chat) return prepareChat(connection);
  if (id === ids.filePath || id === ids.fileMention) return prepareFilePreview(connection, request, id === ids.fileMention);
  if (id === ids.diagnostic) return prepareDiagnostic(connection);
  if (id === ids.tasksReport || id === ids.tasksOutput) return prepareTasks(connection, id === ids.tasksReport);
  if (id === ids.vaultDraft) return prepareVaultDraft(connection, installedInput);
  if (id === ids.vaultRecovery) return prepareVaultRecovery(connection, installedInput);
  if (id === ids.vaultRawValue) return prepareVaultRawValue(connection, installedInput);
  if (id === ids.password) return preparePassword(connection, installedInput);
  if (id === ids.workDoctor || id === ids.workPanelUrl || id === ids.workStageUrl) {
    return prepareWorkPreview(connection, installedInput, request, id);
  }
  if (id === ids.about) return prepareAbout(connection, installedInput);
  if (id === ids.shellxagent) return prepareShellxagent(connection);
  throw new Error(`missing clipboard preparation for ${id}`);
}

async function prepareBrowser(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  const task = await apiJson<Record<string, unknown>>(connection, "POST", "/browser/task/start", {
    goal: "Owned clipboard lifecycle fixture",
    profileId: "task-disposable",
    autonomy: "assistedAutonomous",
    startUrl: "about:blank",
  });
  const taskId = requiredString(task.taskId, "Browser clipboard taskId");
  const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
  return {
    selector: "[data-debug-id='shellx-browser-copy-address']",
    expectedValue: "about:blank",
    cleanup: async () => {
      const errors: string[] = [];
      const result = await cleanupOwnedBrowserLifecycle(
        (method, path, body) => apiJson(connection, method, path, body),
        { taskIds: [taskId], label: "clipboard lifecycle" },
      );
      errors.push(...result.errors);
      try {
        await closeReleaseSurfaceInstalledInputWindow(input);
      } catch (error) {
        errors.push(`close Browser window: ${errorText(error)}`);
      }
      try {
        await switchReleaseSurfaceInstalledInputWindow(input, switched.originalHandle);
      } catch (error) {
        errors.push(`restore app window: ${errorText(error)}`);
      }
      if (errors.length > 0) throw new Error(errors.join("; "));
    },
  };
}

async function prepareActivity(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
): Promise<PreparedControl> {
  const context: ActivityClipboardLifecycleContext = await prepareActivityClipboardLifecycle(connection, input, request);
  const source = await apiJson<Record<string, unknown>>(
    connection,
    "GET",
    `/state/session_activity?tabId=${encodeURIComponent(context.ownedTabId)}`,
  );
  const cwd = typeof source.cwd === "string" ? source.cwd : context.fixture.cwd;
  const hunk = parseHunkRecordsJsonl(String(source.hunkRecordsJsonl ?? ""), {
    rootPath: cwd,
    sourcePath: typeof source.hunkRecordsPath === "string" ? source.hunkRecordsPath : undefined,
  });
  const updates = parseGrokUpdatesJsonl(String(source.updatesJsonl ?? ""), {
    rootPath: cwd,
    sourcePath: typeof source.updatesPath === "string" ? source.updatesPath : undefined,
  });
  const actions = combineActivityTraces([hunk, updates]).actions;
  const expectedValue = buildActivityClipboardSummary({
    sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
    status: typeof source.status === "string" ? source.status : null,
    transport: typeof source.transport === "string" ? source.transport : null,
    visibleActionCount: actions.length,
    totalActionCount: actions.length,
    summary: summarizeActivity(actions),
    hunkRecordsPath: typeof source.hunkRecordsPath === "string" ? source.hunkRecordsPath : null,
    updatesPath: typeof source.updatesPath === "string" ? source.updatesPath : null,
  });
  return {
    selector: `${ACTIVITY} [id='activity-copy-summary']`,
    expectedValue,
    cleanup: async () => {
      const error = await cleanupActivityClipboardLifecycle(connection, input, context);
      if (error) throw new Error(error);
    },
  };
}

async function prepareAgent(connection: Connection, input: InstalledInput, confirmation: boolean): Promise<PreparedControl> {
  await postUi(connection, {
    agentCliSetupFixture: confirmation ? "clipboard-confirmation" : "clipboard-cards",
  });
  await waitForReleaseSurfaceInstalledInputElement(input, AGENT_SETUP);
  return {
    selector: confirmation
      ? ".agent-cli-setup-confirm-links button:nth-child(2)"
      : ".agent-cli-setup-card-actions button:nth-child(2)",
    expectedValue: OWNED_AGENT_CLI_CLIPBOARD_COMMAND,
    cleanup: () => postUi(connection, { agentCliSetupFixture: "closed" }),
  };
}

async function prepareBuiltinDoc(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await openSettingsTab(connection, input, "about");
  const open = await waitForReleaseSurfaceInstalledInputElement(input, "[title='Read the shellX features overview']");
  await clickReleaseSurfaceInstalledInputElement(input, open);
  await waitForReleaseSurfaceInstalledInputElement(input, "[role='dialog'][aria-label='Features']");
  return {
    selector: "[role='dialog'][aria-label='Features'] [aria-label='Copy to clipboard']",
    expectedValue: BUILTIN_DOC_CODE,
    cleanup: () => closeAllUi(connection),
  };
}

async function prepareChat(connection: Connection): Promise<PreparedControl> {
  await postUi(connection, { bottomTab: "Chat", debugRendererFixture: { id: "chat-output-lifecycle" } });
  return {
    selector: ".chat-output [aria-label='Copy to clipboard']",
    expectedValue: `${OWNED_CHAT_CLIPBOARD_CODE}\n`,
    cleanup: async () => {
      await postUi(connection, { debugRendererFixture: { id: "chat-output-lifecycle", action: "clear" } });
    },
  };
}

async function prepareFilePreview(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
  mention: boolean,
): Promise<PreparedControl> {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const nodeRoot = join(dirname(dirname(tokenPath)), "ui-clipboard-file");
  if (existsSync(nodeRoot)) throw new Error("owned clipboard file root already exists");
  mkdirSync(nodeRoot, { mode: 0o700 });
  const nativeWindows = request.platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(request.runtime.debugTokenPath);
  const nativeDirname = nativeWindows ? win32.dirname : dirname;
  const nativeJoin = nativeWindows ? win32.join : join;
  const launchRoot = nativeJoin(nativeDirname(nativeDirname(request.runtime.debugTokenPath)), "ui-clipboard-file");
  const launchPath = nativeJoin(launchRoot, "owned.txt");
  writeFileSync(join(nodeRoot, "owned.txt"), "owned clipboard file\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const ui = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const activeTab = requiredRecord(ui.activeTab, "File clipboard activeTab");
  const tabId = requiredString(activeTab.tabId, "File clipboard tabId");
  await postUi(connection, {
    preview: { kind: "file", path: launchPath, tabId, sessionCwd: launchRoot },
    openModal: "preview",
  });
  return {
    selector: mention
      ? "[title^='Copies `@<path>` to clipboard']"
      : "[title='Copy absolute path to clipboard']",
    expectedValue: mention ? `@${launchPath} ` : launchPath,
    cleanup: async () => {
      try {
        await closeAllUi(connection);
      } finally {
        rmSync(nodeRoot, { recursive: true });
      }
    },
  };
}

async function prepareDiagnostic(connection: Connection): Promise<PreparedControl> {
  const ui = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  const tabId = typeof ui.activeTabId === "string" ? ui.activeTabId : "release-owned-tab";
  const fixture = debugRightRailGitLifecycleFixture({ id: "right-rail-git-lifecycle" }, tabId);
  if (!fixture) throw new Error("owned environment fixture was unavailable");
  await postUi(connection, { rightTab: "Tooling", debugRendererFixture: { id: "right-rail-git-lifecycle" } });
  return {
    selector: "[title='Copy environment diagnostic report']",
    expectedValue: buildGrokEnvironmentReport(fixture.environmentSnapshot as unknown as GrokEnvironmentSnapshot),
    cleanup: async () => {
      await postUi(connection, { rightTab: typeof ui.rightTab === "string" ? ui.rightTab : "Tasks" });
      await postUi(connection, { debugRendererFixture: { id: "right-rail-git-lifecycle", action: "clear" } });
    },
  };
}

async function prepareTasks(connection: Connection, report: boolean): Promise<PreparedControl> {
  const ui = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
  await postUi(connection, { rightTab: "Tasks", debugClipboardFixture: "tasks" });
  return {
    selector: report
      ? "[title='Copy a compact report for visible tasks']"
      : "[title=\"Copy this task's latest output\"]",
    expectedValue: report
      ? buildTasksReport([{ ...OWNED_CLIPBOARD_TASK }], {
          activeTabId: typeof ui.activeTabId === "string" ? ui.activeTabId : null,
          showAllTabs: false,
          filter: "",
        })
      : OWNED_CLIPBOARD_TASK_OUTPUT,
    cleanup: async () => {
      await postUi(connection, { debugClipboardFixture: "clear", rightTab: typeof ui.rightTab === "string" ? ui.rightTab : "Tasks" });
    },
  };
}

async function prepareVaultDraft(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await postUi(connection, { debugClipboardFixture: "vault-draft", openModal: "settings" });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS);
  const field = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='vault-secret-value-input']");
  await setReleaseSurfaceInstalledInputElementValue(input, field, VAULT_DRAFT_VALUE);
  return {
    selector: "[title='Copy without revealing']",
    expectedValue: VAULT_DRAFT_VALUE,
    cleanup: async () => {
      await clearReleaseSurfaceInstalledInputElement(input, field);
      await closeAllUi(connection);
      await postUi(connection, { debugClipboardFixture: "clear" });
    },
  };
}

async function prepareVaultRecovery(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await postUi(connection, { debugClipboardFixture: "vault-draft", openModal: "settings" });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS);
  const setup = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='vault-tab-setup']");
  await clickReleaseSurfaceInstalledInputElement(input, setup);
  return {
    selector: "[data-debug-id='shellx-vault-recovery-copy']",
    expectedValue: OWNED_DEBUG_VAULT_RECOVERY_WORDS.join(" "),
    cleanup: async () => {
      await closeAllUi(connection);
      await postUi(connection, { debugClipboardFixture: "clear" });
    },
  };
}

async function prepareVaultRawValue(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await postUi(connection, { debugClipboardFixture: "vault-draft", openModal: "settings" });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS);
  return {
    selector: `[aria-label='Copy value for ${OWNED_DEBUG_VAULT_SECRET_KEY}']`,
    expectedValue: OWNED_DEBUG_VAULT_SECRET_VALUE,
    cleanup: async () => {
      await closeAllUi(connection);
      await postUi(connection, { debugClipboardFixture: "clear" });
    },
  };
}

async function preparePassword(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await postUi(connection, { debugClipboardFixture: "vault-password", vaultRequestCenterOpen: true });
  const open = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='vault-request-generate-password']");
  await clickReleaseSurfaceInstalledInputElement(input, open);
  return {
    selector: "[data-debug-id='vault-password-generator-copy']",
    expectedValue: OWNED_DEBUG_VAULT_PASSWORD,
    cleanup: async () => {
      await postUi(connection, { vaultRequestCenterOpen: false, debugClipboardFixture: "clear" });
    },
  };
}

async function prepareWorkPreview(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  id: string,
): Promise<PreparedControl> {
  const fixture: PreviewFixture = prepareWorkPreviewFixture(request);
  await hydrateFixtureBaseline(connection, fixture);
  await postWorkPreviewUi(connection, {
    rightTab: "Preview",
    activeTabId: fixture.tabId,
    activeTab: { ...fixture.baselineActiveTab, cwd: fixture.launchRoot },
    source: "final-surface-work-preview-clipboard",
  });
  const start = await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_START_SELECTOR);
  await clickReleaseSurfaceInstalledInputElement(input, start);
  const running = await waitForRunningState(connection, fixture);
  const url = verifyRunningState(running, fixture);
  await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_CENTER_DIALOG);
  let selector = "[id='work-preview-stage-copy-url']";
  let expectedValue = url;
  if (id === ids.workPanelUrl || id === ids.workDoctor) {
    const close = await waitForReleaseSurfaceInstalledInputElement(input, WORK_PREVIEW_CENTER_CLOSE);
    await clickReleaseSurfaceInstalledInputElement(input, close);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, WORK_PREVIEW_CENTER_DIALOG);
    if (id === ids.workPanelUrl) selector = "[id='work-preview-panel-copy-url']";
    else {
      await postUi(connection, { debugClipboardFixture: "work-preview" });
      const doctor = await waitForReleaseSurfaceInstalledInputElement(input, "[id='work-preview-doctor']");
      await clickReleaseSurfaceInstalledInputElement(input, doctor);
      await waitForReleaseSurfaceInstalledInputElement(input, "[id='work-preview-copy-doctor-report']", { timeoutMs: 30_000, pollMs: 100 });
      selector = "[id='work-preview-copy-doctor-report']";
      expectedValue = formatPreviewDoctorReport(
        buildOwnedClipboardPreviewDiagnostic(running as unknown as WorkPreviewState),
      );
    }
  }
  return {
    selector,
    expectedValue,
    cleanup: async () => {
      const open = Boolean(await waitOptional(input, PREVIEW_CENTER));
      const error = await cleanupWorkPreviewFixture(connection, input, fixture, open);
      try {
        if (error) throw new Error(error);
      } finally {
        await postUi(connection, { debugClipboardFixture: "clear" });
      }
    },
  };
}

async function prepareAbout(connection: Connection, input: InstalledInput): Promise<PreparedControl> {
  await openSettingsTab(connection, input, "about");
  return {
    selector: "[data-debug-id='surface-components-settings-abouttab-3']",
    expectedValue: AUTHOR_EMAIL,
    cleanup: () => closeAllUi(connection),
  };
}

async function prepareShellxagent(connection: Connection): Promise<PreparedControl> {
  await postUi(connection, { debugClipboardFixture: "shellxagent-token", openModal: "settings" });
  return {
    selector: "[data-debug-id='surface-components-settings-shellxagenttab-2']",
    expectedValue: OWNED_DEBUG_TOKEN,
    cleanup: async () => {
      await closeAllUi(connection);
      await postUi(connection, { debugClipboardFixture: "clear" });
    },
  };
}

async function openSettingsTab(connection: Connection, input: InstalledInput, tab: string): Promise<void> {
  await postUi(connection, { openModal: "settings" });
  await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS);
  const control = await waitForReleaseSurfaceInstalledInputElement(input, `[data-debug-id='settings-tab-${tab}']`);
  await clickReleaseSurfaceInstalledInputElement(input, control);
}

async function closeAllUi(connection: Connection): Promise<void> {
  await postUi(connection, { openModal: "close", vaultRequestCenterOpen: false });
}

async function postUi(connection: Connection, patch: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-clipboard-lifecycle",
    ...patch,
  });
  await delay(120);
}

async function apiJson<T>(
  connection: Connection,
  method: string,
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return await response.json() as T;
}

async function waitOptional(input: InstalledInput, selector: string): Promise<unknown | null> {
  try {
    return await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 250, pollMs: 50 });
  } catch {
    return null;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing`);
  return value as Record<string, unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
