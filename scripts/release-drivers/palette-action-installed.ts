import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  createReleaseSurfaceInstalledInputSession,
  findReleaseSurfaceInstalledInputElement as findReleaseSurfaceWebDriverElement,
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
import {
  cleanupOwnedScreenshotAttachmentProof,
  prepareOwnedScreenshotAttachmentProof,
  verifyOwnedScreenshotAttachmentChip,
  waitForOwnedScreenshotAttachment,
  type OwnedScreenshotAttachmentProof,
} from "./owned-screenshot-attachment";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "palette-action-installed",
  kind: "palette-action",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/lib/release-surface-run-profile.ts",
    "scripts/release-drivers/owned-screenshot-attachment.ts",
  ],
  supportedFixtures: [
    "palette:app-shell-visible",
    "palette:isolated-run-profile-with-empty-composer",
    "palette:isolated-local-grok-session",
  ],
  supportedCleanups: [
    "palette:close-modal-and-clear-highlights",
    "palette:remove-chip-and-delete-exact-owned-screenshot",
    "palette:abort-owned-grok-session-and-restore-tab",
  ],
  supportedOracles: [
    "palette:act-settings:visible-effect",
    "palette:act-help:visible-effect",
    "palette:act-asset-board:visible-effect",
    "palette:act-pr:visible-effect",
    "palette:act-vault:visible-effect",
    "palette:act-open-work-preview:visible-effect",
    "palette:act-desktop-integrations:visible-effect",
    "palette:act-toggle-term:state-transition",
    "palette:act-new:session-created",
    "palette:act-close:session-closed",
    "palette:act-auto-auto:autonomy-changed",
    "palette:act-attach-screenshot:owned-screenshot-attached",
    "palette:act-connect:owned-grok-session-active",
    "palette:act-abort:owned-grok-session-aborted",
  ],
};

const ACTIONS: Record<string, { effectSelector: string; effectLabel: string }> = {
  "act-settings": { effectSelector: ".settings-modal", effectLabel: "Settings dialog" },
  "act-help": { effectSelector: ".modal[aria-label='Keyboard shortcuts']", effectLabel: "keyboard shortcuts dialog" },
  "act-asset-board": { effectSelector: ".asset-board-modal", effectLabel: "Attachment and Media Board" },
  "act-pr": { effectSelector: ".pr-modal", effectLabel: "Create pull request dialog" },
  "act-vault": { effectSelector: "[data-debug-id='vault-workspace-modal']", effectLabel: "Vault workspace" },
  "act-open-work-preview": { effectSelector: ".preview-center-modal .preview-center-body-work", effectLabel: "Work Preview in work mode" },
  "act-desktop-integrations": {
    effectSelector: "[data-debug-id='settings-tab-desktop'].active[aria-selected='true']",
    effectLabel: "Desktop integrations settings tab",
  },
  "act-toggle-term": {
    effectSelector: "[data-debug-id='bottom-tab-terminal'].active",
    effectLabel: "active Terminal bottom tab",
  },
};

type Json = Record<string, unknown>;
type UiState = Json & {
  activeTab?: unknown;
  activeTabId?: unknown;
  autonomy?: unknown;
  openTabs?: unknown;
};
type SessionActionBaseline = {
  activeTabId: string;
  openTabIds: string[];
  ownedTabId: string;
};

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);

  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseAction(request, connection, installedInput, assignment));
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

async function exerciseAction(
  request: ReleaseSurfaceDriverRequest,
  connection: { base: string; token: string },
  webdriver: ReleaseSurfaceInstalledInputSession,
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
    observedEffect: "No palette action effect was observed.",
  };
  const actionId = assignment.surface.name;
  const action = ACTIONS[actionId];
  const actionSelector = `[data-palette-action-id='${actionId}']`;
  let baselineIds: string[] = [];
  let baselineActiveId = "";
  let baselineAutonomy = "";
  let screenshotProof: OwnedScreenshotAttachmentProof | null = null;
  let sessionBaseline: SessionActionBaseline | null = null;
  try {
    if (!action && ![
      "act-new",
      "act-close",
      "act-auto-auto",
      "act-attach-screenshot",
      "act-connect",
      "act-abort",
    ].includes(actionId)) {
      throw new Error(`palette fixture does not support ${actionId}`);
    }
    await postUi(connection, {
      openModal: "close",
      debugHighlights: [],
      ...(actionId === "act-toggle-term" ? { bottomTab: "Chat" } : {}),
    });
    if (actionId === "act-toggle-term") {
      await waitForUiState(connection, (state) => state.bottomTab === "Chat", "Chat bottom-tab baseline");
    }
    if (actionId === "act-new" || actionId === "act-close") {
      const baseline = await waitForUiState(connection, (state) => sessionIds(state).length > 0, "session baseline");
      baselineIds = sessionIds(baseline);
      baselineActiveId = activeTabId(baseline);
      if (!baselineActiveId || !baselineIds.includes(baselineActiveId)) {
        throw new Error("session baseline does not identify an active renderer tab");
      }
      if (actionId === "act-close") {
        await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "t"]);
        await waitForUiState(connection, (state) => {
          const ids = sessionIds(state);
          const active = activeTabId(state);
          return ids.length === baselineIds.length + 1
            && baselineIds.every((id) => ids.includes(id))
            && Boolean(active && !baselineIds.includes(active));
        }, "disposable close-session tab");
      }
    }
    if (actionId === "act-auto-auto") {
      const baseline = await waitForUiState(connection, (state) => autonomyMode(state) !== "", "autonomy baseline");
      baselineAutonomy = autonomyMode(baseline);
      const target = "bypassPermissions";
      if (baselineAutonomy !== target) {
        throw new Error(`autonomy baseline must already be the shipped Full Auto mode, got ${baselineAutonomy}`);
      }
      await postUi(connection, { releaseTestLegacyAutonomy: "legacy-default" });
      await waitForUiState(connection, (state) => autonomyMode(state) === "default", `${actionId} legacy migration fixture`);
    }
    if (actionId === "act-attach-screenshot") {
      await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, ".composer-attachment-chip");
      screenshotProof = prepareOwnedScreenshotAttachmentProof(request);
    }
    if (actionId === "act-connect" || actionId === "act-abort") {
      sessionBaseline = await prepareSessionAction(request, connection, webdriver, actionId);
    }
    await postUi(connection, { openModal: "palette" });
    const element = await waitForReleaseSurfaceWebDriverElement(webdriver, actionSelector);
    outcome.present = "pass";

    await clickReleaseSurfaceWebDriverElement(webdriver, element);
    outcome.invoke = "pass";
    if (actionId === "act-new") {
      await waitForUiState(connection, (next) => {
        const ids = sessionIds(next);
        const active = activeTabId(next);
        return ids.length === baselineIds.length + 1
          && baselineIds.every((id) => ids.includes(id))
          && Boolean(active && !baselineIds.includes(active));
      }, "new-session palette effect");
      outcome.observedEffect = `${actionId} received a native installed-input click and created one active renderer tab; the tab identity was not retained.`;
    } else if (actionId === "act-close") {
      await waitForExactSessionBaseline(connection, baselineIds, baselineActiveId, "close-session palette effect");
      outcome.observedEffect = `${actionId} received a native installed-input click and removed only the prepared disposable renderer tab.`;
    } else if (actionId === "act-auto-auto") {
      const target = "bypassPermissions";
      await waitForUiState(connection, (state) => autonomyMode(state) === target, `${actionId} palette effect`);
      outcome.observedEffect = `${actionId} received a native installed-input click and changed renderer-backed autonomy state to ${target}.`;
    } else if (actionId === "act-attach-screenshot") {
      if (!screenshotProof) throw new Error("screenshot proof fixture was not prepared");
      await waitForReleaseSurfaceWebDriverElement(
        webdriver,
        ".composer-attachment-chip.composer-attachment-image",
        { timeoutMs: 15_000, pollMs: 50 },
      );
      const screenshot = await waitForOwnedScreenshotAttachment(screenshotProof);
      screenshotProof.createdLocalPath = screenshot.localPath;
      await verifyOwnedScreenshotAttachmentChip(webdriver, screenshot.launchPath);
      outcome.observedEffect = `${actionId} received a native installed-input click, created one non-empty PNG inside the isolated run profile, and attached that exact file as an image chip.`;
    } else if (actionId === "act-connect") {
      if (!sessionBaseline) throw new Error("Connect session fixture was not prepared");
      await waitForSessionChild(connection, sessionBaseline.ownedTabId, true, "palette Connect provider child");
      await waitForUiState(connection, (state) => activeTabStatus(state) === "Connected", "palette Connect renderer status");
      outcome.observedEffect = "act-connect received a native installed-input click, started and initialized one real local Grok ACP child for the exact isolated tab without sending a provider prompt, and exposed matching registry and renderer Connected state.";
    } else if (actionId === "act-abort") {
      if (!sessionBaseline) throw new Error("Abort session fixture was not prepared");
      await waitForSessionChild(connection, sessionBaseline.ownedTabId, false, "palette Abort provider cleanup");
      await waitForUiState(connection, (state) => activeTabStatus(state) === "Idle", "palette Abort renderer status");
      outcome.observedEffect = "act-abort received a native installed-input click, terminated the exact release-owned Grok ACP child, removed its registry slot, and returned the isolated renderer tab to Idle.";
    } else if (action) {
      await waitForReleaseSurfaceWebDriverElement(webdriver, action.effectSelector);
      if (actionId === "act-toggle-term") {
        await waitForUiState(connection, (state) => state.bottomTab === "Terminal", "Terminal bottom-tab effect");
      }
      outcome.observedEffect = `${actionId} received a native installed-input click and opened the visible ${action.effectLabel}.`;
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, {
        openModal: "close",
        debugHighlights: [],
        ...(actionId === "act-toggle-term" ? { bottomTab: "Chat" } : {}),
      });
      if (actionId === "act-toggle-term") {
        await waitForUiState(connection, (state) => state.bottomTab === "Chat", "Chat bottom-tab cleanup");
      }
      if ((actionId === "act-new" || actionId === "act-close") && baselineIds.length > 0) {
        await restoreSessionBaseline(request, connection, webdriver, baselineIds, baselineActiveId);
      }
      if (actionId === "act-auto-auto" && baselineAutonomy) {
        await waitForUiState(connection, (next) => autonomyMode(next) === baselineAutonomy, "autonomy cleanup");
      }
      if (actionId === "act-attach-screenshot") {
        await cleanupScreenshotAction(webdriver, screenshotProof);
      }
      if (sessionBaseline) {
        await cleanupSessionAction(request, connection, webdriver, sessionBaseline);
      }
      if (action) await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, action.effectSelector);
      outcome.cleanup = "pass";
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "palette action did not satisfy every required verdict";
  }
  return outcome;
}

async function prepareSessionAction(
  request: ReleaseSurfaceDriverRequest,
  connection: { base: string; token: string },
  webdriver: ReleaseSurfaceInstalledInputSession,
  actionId: string,
): Promise<SessionActionBaseline> {
  const baseline = await uiState(connection);
  const baselineIds = sessionIds(baseline);
  const baselineActiveId = activeTabId(baseline);
  if (!baselineActiveId || !baselineIds.includes(baselineActiveId)) {
    throw new Error("palette session baseline did not expose one exact active renderer tab");
  }
  await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "t"]);
  const ownedState = await waitForUiState(connection, (state) => {
    const ids = sessionIds(state);
    const active = activeTabId(state);
    return ids.length === baselineIds.length + 1
      && baselineIds.every((id) => ids.includes(id))
      && Boolean(active && !baselineIds.includes(active));
  }, "disposable palette session tab");
  const tabId = activeTabId(ownedState);
  if (await sessionHasActiveChild(connection, tabId)) {
    throw new Error("palette session lifecycle refuses to replace an already-active provider child");
  }
  const cwd = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const ownedTab: Json = {
    tabId,
    cwd,
    connectionId: null,
    connectionLabel: "Local",
    connectionTransport: "local",
  };
  await postUi(connection, {
    activeTab: ownedTab,
    activeTabId: tabId,
    ...(actionId === "act-connect" ? { debugAgentPickerFixture: "owned-ready" } : {}),
  });
  await waitForUiState(connection, (state) => {
    const current = state.activeTab !== null
      && typeof state.activeTab === "object"
      && !Array.isArray(state.activeTab)
      ? state.activeTab as Json
      : null;
    return activeTabId(state) === tabId
      && current?.tabId === tabId
      && current.cwd === cwd
      && current.connectionId === null
      && current.connectionLabel === "Local"
      && current.connectionTransport === "local";
  }, "owned local Grok tab baseline");
  if (actionId === "act-connect") {
    const picker = await waitForReleaseSurfaceWebDriverElement(webdriver, "[data-debug-id='composer-agent']");
    await clickReleaseSurfaceWebDriverElement(webdriver, picker);
    const grok = await waitForReleaseSurfaceWebDriverElement(webdriver, "[data-agent-id='grok']");
    await clickReleaseSurfaceWebDriverElement(webdriver, grok);
    await waitForUiState(
      connection,
      (state) => activeTabAgent(state) === "grok",
      "owned local Grok agent selection",
    );
  }
  if (actionId === "act-abort") {
    await apiJson(connection, "POST", "/connect", {
      cwd,
      tabId,
      restart: false,
      loadSessionId: null,
      mcpServers: null,
    });
    await waitForSessionChild(connection, tabId, true, "palette Abort setup provider child");
  }
  return { activeTabId: baselineActiveId, openTabIds: baselineIds, ownedTabId: tabId };
}

async function cleanupSessionAction(
  request: ReleaseSurfaceDriverRequest,
  connection: { base: string; token: string },
  webdriver: ReleaseSurfaceInstalledInputSession,
  baseline: SessionActionBaseline,
): Promise<void> {
  if (await sessionHasActiveChild(connection, baseline.ownedTabId)) {
    await apiJson(
      connection,
      "POST",
      `/abort?tabId=${encodeURIComponent(baseline.ownedTabId)}`,
      {},
    );
  }
  await postUi(connection, { debugAgentPickerFixture: "clear" });
  await waitForSessionChild(connection, baseline.ownedTabId, false, "palette session cleanup");
  await postUi(connection, { activeTabId: baseline.ownedTabId });
  await waitForUiState(
    connection,
    (state) => activeTabId(state) === baseline.ownedTabId,
    "owned palette session focus cleanup",
  );
  await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "w"]);
  await waitForExactSessionBaseline(
    connection,
    baseline.openTabIds,
    baseline.activeTabId,
    "palette exact tab restoration",
  );
}

async function waitForSessionChild(
  connection: { base: string; token: string },
  tabId: string,
  expected: boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await sessionHasActiveChild(connection, tabId) === expected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} did not reach hasActiveChild=${expected}`);
}

async function sessionHasActiveChild(
  connection: { base: string; token: string },
  tabId: string,
): Promise<boolean> {
  const state = await apiJson<Json>(connection, "GET", "/state/sessions");
  if (!Array.isArray(state.tabs)) throw new Error("session registry omitted its bounded tabs array");
  const matches = state.tabs.filter((value) => {
    const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
    return row?.tabId === tabId;
  });
  if (matches.length > 1) throw new Error("session registry returned duplicate tab identities");
  if (matches.length === 0) return false;
  if (typeof (matches[0] as Json).hasActiveChild !== "boolean") {
    throw new Error("session registry row omitted hasActiveChild");
  }
  return (matches[0] as Json).hasActiveChild as boolean;
}

function activeTabStatus(state: UiState): string {
  const active = activeOpenTab(state);
  const status = active?.status;
  return typeof status === "string" ? status : "";
}

function activeTabAgent(state: UiState): string {
  const agentId = activeOpenTab(state)?.agentId;
  return typeof agentId === "string" ? agentId : "";
}

function activeOpenTab(state: UiState): Json | null {
  const id = activeTabId(state);
  if (!id || !Array.isArray(state.openTabs)) return null;
  const matches = state.openTabs.filter((value) => (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Json).tabId === id
  ));
  return matches.length === 1 ? matches[0] as Json : null;
}

async function cleanupScreenshotAction(
  webdriver: ReleaseSurfaceInstalledInputSession,
  proof: OwnedScreenshotAttachmentProof | null,
): Promise<void> {
  let uiError: unknown = null;
  try {
    const remove = await findReleaseSurfaceWebDriverElement(webdriver, ".composer-attachment-remove");
    if (remove) await clickReleaseSurfaceWebDriverElement(webdriver, remove);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, ".composer-attachment-chip");
  } catch (error) {
    uiError = error;
  }
  let fileError: unknown = null;
  try {
    cleanupOwnedScreenshotAttachmentProof(proof);
  } catch (error) {
    fileError = error;
  }
  if (uiError || fileError) {
    const details = [uiError, fileError]
      .filter((error) => error !== null)
      .map((error) => error instanceof Error ? error.message : String(error));
    throw new Error(details.join("; "));
  }
}

async function restoreSessionBaseline(
  request: ReleaseSurfaceDriverRequest,
  connection: { base: string; token: string },
  webdriver: ReleaseSurfaceInstalledInputSession,
  baselineIds: string[],
  baselineActiveId: string,
): Promise<void> {
  const state = await uiState(connection);
  const extras = sessionIds(state).filter((id) => !baselineIds.includes(id));
  if (extras.length === 1 && sessionIds(state).length === baselineIds.length + 1) {
    if (activeTabId(state) !== extras[0]) {
      await postUi(connection, { activeTabId: extras[0] });
      await waitForUiState(connection, (next) => activeTabId(next) === extras[0], "disposable session focus cleanup");
    }
    await performReleaseSurfaceWebDriverKeyChord(webdriver, [commandKey(request), "w"]);
  }
  await waitForExactSessionBaseline(connection, baselineIds, baselineActiveId, "session cleanup");
}

async function waitForExactSessionBaseline(
  connection: { base: string; token: string },
  baselineIds: string[],
  baselineActiveId: string,
  label: string,
): Promise<void> {
  await waitForUiState(connection, (state) => {
    const ids = sessionIds(state);
    return ids.length === baselineIds.length
      && ids.every((id) => baselineIds.includes(id))
      && activeTabId(state) === baselineActiveId;
  }, label);
}

function commandKey(request: ReleaseSurfaceDriverRequest): string {
  return request.platform === "macos-installed" ? "\uE03D" : "\uE009";
}

async function uiState(connection: { base: string; token: string }): Promise<UiState> {
  return apiJson<UiState>(connection, "GET", "/state/ui");
}

function sessionIds(state: UiState): string[] {
  if (!Array.isArray(state.openTabs)) return [];
  return state.openTabs.flatMap((tab) => {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return [];
    const id = (tab as Record<string, unknown>).tabId;
    return typeof id === "string" && id.trim() ? [id] : [];
  });
}

function activeTabId(state: UiState): string {
  return typeof state.activeTabId === "string" ? state.activeTabId : "";
}

function autonomyMode(state: UiState): string {
  if (typeof state.autonomy === "string") return state.autonomy;
  if (state.activeTab && typeof state.activeTab === "object" && !Array.isArray(state.activeTab)) {
    const nested = (state.activeTab as Record<string, unknown>).autonomy;
    if (typeof nested === "string") return nested;
  }
  return "";
}

async function waitForUiState(
  connection: { base: string; token: string },
  predicate: (state: UiState) => boolean,
  label: string,
): Promise<UiState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await uiState(connection);
    if (predicate(state)) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} did not appear before timeout`);
}

async function postUi(connection: { base: string; token: string }, body: Json): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-palette-driver",
    ...body,
  });
}

async function apiResponse(
  connection: { base: string; token: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  return response;
}

async function apiJson<T>(
  connection: { base: string; token: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return await (await apiResponse(connection, method, path, body)).json() as T;
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
