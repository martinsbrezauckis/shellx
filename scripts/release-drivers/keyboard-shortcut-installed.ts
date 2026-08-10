import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  createReleaseSurfaceInstalledInputSession,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord as performReleaseSurfaceWebDriverKeyChord,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "keyboard-shortcut-installed",
  kind: "keyboard-shortcut",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "src/lib/debug-renderer-fixture.ts",
  ],
  supportedFixtures: [
    "keyboard:app-shell-visible",
    "keyboard:settings-visible",
    "keyboard:chat-bottom-tab",
    "keyboard:session-baseline",
    "keyboard:owned-renderer-diff",
  ],
  supportedCleanups: [
    "keyboard:close-modal",
    "keyboard:modal-closed",
    "keyboard:restore-chat-bottom-tab",
    "keyboard:restore-session-baseline",
    "keyboard:clear-owned-renderer-diff-and-restore-tabs",
  ],
  supportedOracles: [
    "keyboard:help:dialog-visible",
    "keyboard:escape:modal-closed",
    "keyboard:palette:dialog-visible",
    "keyboard:settings:dialog-visible",
    "keyboard:toggle-terminal:state-transition",
    "keyboard:new-session:state-transition",
    "keyboard:close-session:state-transition",
    "keyboard:diff-next:diff-hunk-effect",
    "keyboard:diff-prev:diff-hunk-effect",
    "keyboard:diff-accept:diff-hunk-effect",
    "keyboard:diff-reject:diff-hunk-effect",
  ],
};

type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type ShortcutSpec = {
  effectSelector: string;
  setup: (connection: Connection, webdriver: WebDriver) => Promise<void>;
  invoke: (connection: Connection, request: ReleaseSurfaceDriverRequest, webdriver: WebDriver) => Promise<void>;
  assertEffect: (connection: Connection, webdriver: WebDriver) => Promise<string>;
  cleanup: (connection: Connection, webdriver: WebDriver) => Promise<void>;
};

const HELP_SELECTOR = "[role='dialog'][aria-label='Keyboard shortcuts']";
const PALETTE_SELECTOR = "[role='dialog'][aria-label='Command palette']";
const SETTINGS_SELECTOR = ".settings-modal[role='dialog']";
const TERMINAL_SELECTOR = "[data-debug-id='bottom-tab-terminal'].active";
const CHAT_SELECTOR = "[data-debug-id='bottom-tab-chat'].active";
const ACTIVE_SESSION_SELECTOR = "[data-debug-id='session-tab'].active";
const DIFF_HUNK_SELECTOR = ".tool-diff [data-hunk]";
const OWNED_DIFF_HUNK_COUNT = 3;
const DIFF_SHORTCUTS = new Set(["diff-next", "diff-prev", "diff-accept", "diff-reject"]);

type UiOpenTab = { tabId?: unknown };
type UiState = Record<string, unknown> & {
  activeTabId?: unknown;
  openTabs?: unknown;
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const diffAssignments = request.assignments.filter((assignment) => DIFF_SHORTCUTS.has(assignment.surface.name));
  let diffFixture: DiffSessionFixture | null = null;
  let diffFixtureError: string | null = null;
  if (diffAssignments.length > 0) {
    try {
      diffFixture = await prepareDiffSessionFixture(connection, installedInput);
    } catch (error) {
      diffFixtureError = error instanceof Error ? error.message : String(error);
    }
  }
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(diffFixtureError && DIFF_SHORTCUTS.has(assignment.surface.name)
      ? failedShortcutOutcome(assignment, diffFixtureError)
      : await exerciseShortcut(request, connection, installedInput, assignment));
  }
  if (diffFixture) {
    const cleanupError = await cleanupDiffSessionFixture(
      connection,
      installedInput,
      diffFixture,
    );
    if (cleanupError) {
      for (const outcome of outcomes.filter((item) => DIFF_SHORTCUTS.has(item.id.slice("keyboard-shortcut:".length)))) {
        outcome.cleanup = "fail";
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      }
    }
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

async function exerciseShortcut(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  webdriver: WebDriver,
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
): Promise<ReleaseSurfaceDriverOutcome> {
  const id = assignment.surface.name;
  const spec = shortcutSpec(id);
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No keyboard shortcut effect was observed.",
  };
  try {
    if (!spec) throw new Error(`keyboard fixture does not support ${id}`);
    await spec.setup(connection, webdriver);
    outcome.present = "pass";
    await spec.invoke(connection, request, webdriver);
    outcome.invoke = "pass";
    outcome.observedEffect = await spec.assertEffect(connection, webdriver);
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (spec) await spec.cleanup(connection, webdriver);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "keyboard shortcut did not satisfy every required verdict";
  }
  return outcome;
}

function shortcutSpec(id: string): ShortcutSpec | null {
  const modal = (
    selector: string,
    keys: (request: ReleaseSurfaceDriverRequest) => string[],
    label: string,
  ): ShortcutSpec => ({
    setup: prepareClosedShell,
    effectSelector: selector,
    invoke: async (_connection, request, webdriver) => performReleaseSurfaceWebDriverKeyChord(webdriver, keys(request)),
    assertEffect: async (_connection, webdriver) => {
      await waitForReleaseSurfaceWebDriverElement(webdriver, selector);
      return `${label} became visible after the native WebDriver key chord.`;
    },
    cleanup: async (connection, webdriver) => closeModal(connection, webdriver, selector),
  });
  if (id === "help") return modal(HELP_SELECTOR, () => ["?"], "Keyboard shortcuts dialog");
  if (id === "palette") return modal(PALETTE_SELECTOR, (request) => [commandKey(request), "k"], "Command palette");
  if (id === "settings") return modal(SETTINGS_SELECTOR, (request) => [commandKey(request), ","], "Settings dialog");
  if (id === "escape") return {
    effectSelector: SETTINGS_SELECTOR,
    setup: async (connection, webdriver) => {
      await postUi(connection, { openModal: "settings" });
      await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_SELECTOR);
    },
    invoke: async (_connection, _request, webdriver) => performReleaseSurfaceWebDriverKeyChord(webdriver, ["\uE00C"]),
    assertEffect: async (_connection, webdriver) => {
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_SELECTOR);
      return "Escape closed the prepared Settings dialog through a native WebDriver key event.";
    },
    cleanup: async (connection, webdriver) => closeModal(connection, webdriver, SETTINGS_SELECTOR),
  };
  if (id === "toggle-terminal") return {
    effectSelector: TERMINAL_SELECTOR,
    setup: async (connection, webdriver) => {
      await postUi(connection, { openModal: "close", bottomTab: "Chat" });
      await waitForUiState(connection, (state) => state.bottomTab === "Chat", "Chat bottom tab setup");
      await waitForReleaseSurfaceWebDriverElement(webdriver, CHAT_SELECTOR);
    },
    invoke: async (_connection, request, webdriver) => performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "`"]),
    assertEffect: async (connection, webdriver) => {
      await waitForUiState(connection, (state) => state.bottomTab === "Terminal", "Terminal bottom tab effect");
      await waitForReleaseSurfaceWebDriverElement(webdriver, TERMINAL_SELECTOR);
      return "The native command-backtick chord changed both renderer state and the active tab to Terminal.";
    },
    cleanup: async (connection, webdriver) => {
      await postUi(connection, { bottomTab: "Chat" });
      await waitForUiState(connection, (state) => state.bottomTab === "Chat", "Chat bottom tab cleanup");
      await waitForReleaseSurfaceWebDriverElement(webdriver, CHAT_SELECTOR);
    },
  };
  if (id === "new-session") return sessionCreationSpec();
  if (id === "close-session") return sessionCloseSpec();
  if (DIFF_SHORTCUTS.has(id)) return diffShortcutSpec(id);
  return null;
}

function diffShortcutSpec(id: string): ShortcutSpec {
  const config = {
    "diff-next": { start: 0, key: "j", expected: 1, audit: null, label: "next" },
    "diff-prev": { start: 1, key: "k", expected: 0, audit: null, label: "previous" },
    "diff-accept": { start: 0, key: "y", expected: 0, audit: "accepted", label: "accepted" },
    "diff-reject": { start: 0, key: "n", expected: 0, audit: "rejected", label: "rejected" },
  }[id];
  if (!config) throw new Error(`missing diff shortcut config for ${id}`);
  return {
    effectSelector: `${DIFF_HUNK_SELECTOR}[data-hunk-idx='${config.expected}']`,
    setup: async (connection, webdriver) => {
      await prepareClosedShell(connection, webdriver);
      await waitForReleaseSurfaceWebDriverElement(webdriver, `${DIFF_HUNK_SELECTOR}[data-hunk-idx='0']`);
      await waitForReleaseSurfaceWebDriverElement(webdriver, `${DIFF_HUNK_SELECTOR}[data-hunk-idx='1']`);
      await focusDiffHunk(webdriver, config.start);
      await waitForDiffState(webdriver, (state) => state.index === config.start && state.audit === null, `${id} baseline`);
    },
    invoke: async (_connection, _request, webdriver) => {
      await performReleaseSurfaceWebDriverKeyChord(webdriver, [config.key]);
    },
    assertEffect: async (_connection, webdriver) => {
      await waitForDiffState(
        webdriver,
        (state) => state.index === config.expected && state.audit === config.audit,
        `${id} effect`,
      );
      return `The native ${config.key} key reached the ${config.label} owned diff-hunk state.`;
    },
    cleanup: async (_connection, webdriver) => {
      const state = await readDiffState(webdriver);
      if (config.audit && state.audit === config.audit) {
        await performReleaseSurfaceWebDriverKeyChord(webdriver, [config.key]);
      }
      await focusDiffHunk(webdriver, 0);
      await waitForDiffState(webdriver, (next) => next.index === 0 && next.audit === null, `${id} cleanup`);
    },
  };
}

function sessionCreationSpec(): ShortcutSpec {
  let baselineIds: string[] = [];
  let baselineActiveId = "";
  let createdTabId = "";
  let requestPlatform: ReleaseSurfaceDriverRequest["platform"] = "linux-installed";
  return {
    effectSelector: ACTIVE_SESSION_SELECTOR,
    setup: async (connection, webdriver) => {
      await prepareClosedShell(connection, webdriver);
      const baseline = await waitForSessionState(connection, (state) => sessionIds(state).length > 0, "session baseline");
      baselineIds = sessionIds(baseline);
      baselineActiveId = activeTabId(baseline);
      if (!baselineActiveId || !baselineIds.includes(baselineActiveId)) {
        throw new Error("session baseline did not expose one active renderer tab");
      }
      await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVE_SESSION_SELECTOR);
    },
    invoke: async (_connection, request, webdriver) => {
      requestPlatform = request.platform;
      await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "t"]);
    },
    assertEffect: async (connection, webdriver) => {
      const next = await waitForSessionState(connection, (state) => {
        const ids = sessionIds(state);
        const active = activeTabId(state);
        return ids.length === baselineIds.length + 1
          && baselineIds.every((id) => ids.includes(id))
          && Boolean(active && !baselineIds.includes(active));
      }, "new session effect");
      createdTabId = activeTabId(next);
      await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVE_SESSION_SELECTOR);
      return `The native new-session chord added active renderer tab ${createdTabId} while preserving the baseline tabs.`;
    },
    cleanup: async (connection, webdriver) => {
      const state = await uiState(connection);
      const currentIds = sessionIds(state);
      const extraIds = currentIds.filter((id) => !baselineIds.includes(id));
      if (extraIds.length === 1 && activeTabId(state) === extraIds[0] && currentIds.length === baselineIds.length + 1) {
        await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKeyForPlatform(requestPlatform), "w"]);
      }
      await waitForExactSessionBaseline(connection, webdriver, baselineIds, baselineActiveId, "new session cleanup");
    },
  };
}

function sessionCloseSpec(): ShortcutSpec {
  let baselineIds: string[] = [];
  let baselineActiveId = "";
  let preparedTabId = "";
  let requestPlatform: ReleaseSurfaceDriverRequest["platform"] = "linux-installed";
  return {
    effectSelector: ACTIVE_SESSION_SELECTOR,
    setup: async (connection, webdriver) => {
      await prepareClosedShell(connection, webdriver);
      const baseline = await waitForSessionState(connection, (state) => sessionIds(state).length > 0, "close-session baseline");
      baselineIds = sessionIds(baseline);
      baselineActiveId = activeTabId(baseline);
      await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVE_SESSION_SELECTOR);
    },
    invoke: async (connection, request, webdriver) => {
      requestPlatform = request.platform;
      await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "t"]);
      const prepared = await waitForSessionState(connection, (state) => {
        const ids = sessionIds(state);
        const active = activeTabId(state);
        return ids.length === baselineIds.length + 1
          && baselineIds.every((id) => ids.includes(id))
          && Boolean(active && !baselineIds.includes(active));
      }, "prepared close-session tab");
      preparedTabId = activeTabId(prepared);
      await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVE_SESSION_SELECTOR);
      await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "w"]);
    },
    assertEffect: async (connection, webdriver) => {
      await waitForExactSessionBaseline(connection, webdriver, baselineIds, baselineActiveId, "close-session effect");
      return `The native close-session chord removed only prepared renderer tab ${preparedTabId} and restored the prior active tab.`;
    },
    cleanup: async (connection, webdriver) => {
      const state = await uiState(connection);
      const currentIds = sessionIds(state);
      const extraIds = currentIds.filter((id) => !baselineIds.includes(id));
      if (extraIds.length === 1 && activeTabId(state) === extraIds[0] && currentIds.length === baselineIds.length + 1) {
        await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKeyForPlatform(requestPlatform), "w"]);
      }
      await waitForExactSessionBaseline(connection, webdriver, baselineIds, baselineActiveId, "close-session cleanup");
    },
  };
}

type DiffSessionFixture = {
  baselineIds: string[];
  baselineActiveId: string;
};

type DiffHunkState = {
  index: number;
  audit: "accepted" | "rejected" | null;
};

async function prepareDiffSessionFixture(
  connection: Connection,
  webdriver: WebDriver,
): Promise<DiffSessionFixture> {
  const baseline = await waitForSessionState(connection, (state) => sessionIds(state).length > 0, "diff session baseline");
  const baselineIds = sessionIds(baseline);
  const baselineActiveId = activeTabId(baseline);
  if (!baselineActiveId || !baselineIds.includes(baselineActiveId)) {
    throw new Error("diff session baseline did not expose one active renderer tab");
  }
  try {
    await postUi(connection, { debugRendererFixture: { id: "keyboard-diff-lifecycle" } });
    await waitForReleaseSurfaceWebDriverElement(webdriver, `${DIFF_HUNK_SELECTOR}[data-hunk-idx='0']`);
    await waitForReleaseSurfaceWebDriverElement(webdriver, `${DIFF_HUNK_SELECTOR}[data-hunk-idx='2']`);
    return { baselineIds, baselineActiveId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const cleanupError = await cleanupDiffSessionFixture(connection, webdriver, {
      baselineIds,
      baselineActiveId,
    });
    throw new Error(cleanupError ? `${detail}; cleanup: ${cleanupError}` : detail);
  }
}

async function cleanupDiffSessionFixture(
  connection: Connection,
  webdriver: WebDriver,
  fixture: DiffSessionFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    await postUi(connection, { debugRendererFixture: { id: "keyboard-diff-lifecycle", action: "clear" } });
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, DIFF_HUNK_SELECTOR);
    await waitForExactSessionBaseline(
      connection,
      webdriver,
      fixture.baselineIds,
      fixture.baselineActiveId,
      "diff session tab cleanup",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length > 0 ? errors.join(" | ") : null;
}

async function focusDiffHunk(webdriver: WebDriver, index: number): Promise<void> {
  const hunk = await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    `${DIFF_HUNK_SELECTOR}[data-hunk-idx='${index}']`,
  );
  await clickReleaseSurfaceWebDriverElement(webdriver, hunk);
}

async function readDiffState(webdriver: WebDriver): Promise<DiffHunkState> {
  let activeIndex = -1;
  let activeAudit: DiffHunkState["audit"] = null;
  for (let index = 0; index < OWNED_DIFF_HUNK_COUNT; index += 1) {
    const selector = `${DIFF_HUNK_SELECTOR}[data-hunk-idx='${index}']`;
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["focused"]);
    if (!state.present || !state.visible || typeof state.focused !== "boolean") {
      throw new Error(`owned diff hunk ${index} omitted its declared focus observation`);
    }
    if (!state.focused) continue;
    if (activeIndex !== -1) throw new Error("owned diff session exposed more than one focused hunk");
    activeIndex = index;
    const accepted = await observeReleaseSurfaceInstalledInputElement(webdriver, `${selector}.accepted`, ["focused"]);
    const rejected = await observeReleaseSurfaceInstalledInputElement(webdriver, `${selector}.rejected`, ["focused"]);
    if (accepted.present && rejected.present) throw new Error("owned diff hunk exposed conflicting audit classes");
    if ((accepted.present && accepted.focused !== true) || (rejected.present && rejected.focused !== true)) {
      throw new Error("owned diff hunk audit class did not remain on the focused element");
    }
    activeAudit = accepted.present ? "accepted" : rejected.present ? "rejected" : null;
  }
  if (activeIndex === -1) throw new Error("owned diff session omitted its bounded active hunk");
  return { index: activeIndex, audit: activeAudit };
}

async function waitForDiffState(
  webdriver: WebDriver,
  predicate: (state: DiffHunkState) => boolean,
  label: string,
): Promise<DiffHunkState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readDiffState(webdriver);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

function failedShortcutOutcome(
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  error: string,
): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "The owned diff-session fixture could not be prepared.",
    error,
  };
}

async function prepareClosedShell(connection: Connection, webdriver: WebDriver): Promise<void> {
  await postUi(connection, { openModal: "close", debugHighlights: [] });
  for (const selector of [HELP_SELECTOR, PALETTE_SELECTOR, SETTINGS_SELECTOR]) {
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, selector);
  }
  const shell = await waitForReleaseSurfaceWebDriverElement(webdriver, ".shell");
  await clickReleaseSurfaceWebDriverElement(webdriver, shell);
}

async function closeModal(connection: Connection, webdriver: WebDriver, selector: string): Promise<void> {
  await postUi(connection, { openModal: "close", debugHighlights: [] });
  await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, selector);
}

function commandKey(request: ReleaseSurfaceDriverRequest): string {
  return commandKeyForPlatform(request.platform);
}

function commandKeyForPlatform(platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "macos-installed" ? "\uE03D" : "\uE009";
}

async function uiState(connection: Connection): Promise<UiState> {
  return apiJson<UiState>(connection, "GET", "/state/ui");
}

function sessionIds(state: UiState): string[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((tab) => {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return [];
    const id = (tab as UiOpenTab).tabId;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

function activeTabId(state: UiState): string {
  return typeof state.activeTabId === "string" ? state.activeTabId : "";
}

async function waitForSessionState(
  connection: Connection,
  predicate: (state: UiState) => boolean,
  label: string,
): Promise<UiState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function waitForExactSessionBaseline(
  connection: Connection,
  webdriver: WebDriver,
  baselineIds: string[],
  baselineActiveId: string,
  label: string,
): Promise<void> {
  await waitForSessionState(connection, (state) => {
    const ids = sessionIds(state);
    return ids.length === baselineIds.length
      && ids.every((id, index) => id === baselineIds[index])
      && activeTabId(state) === baselineActiveId;
  }, label);
  await waitForReleaseSurfaceWebDriverElement(webdriver, ACTIVE_SESSION_SELECTOR);
}

async function waitForUiState(
  connection: Connection,
  predicate: (state: Record<string, unknown>) => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await apiJson<Record<string, unknown>>(connection, "GET", "/state/ui");
    if (predicate(state)) return;
    await delay(100);
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-keyboard-driver",
    ...body,
  });
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
