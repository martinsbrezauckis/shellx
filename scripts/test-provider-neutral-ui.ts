import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

const files = {
  app: readFileSync("src/App.tsx", "utf8"),
  bottomPanel: readFileSync("src/components/BottomPanel.tsx", "utf8"),
  uiNavigation: readFileSync("src/lib/ui-navigation.ts", "utf8"),
  header: readFileSync("src/components/Header.tsx", "utf8"),
  rightRail: readFileSync("src/components/RightRail.tsx", "utf8"),
  filesPane: readFileSync("src/components/FilesPane.tsx", "utf8"),
  folderPath: readFileSync("src/lib/folder-path.ts", "utf8"),
  settings: readFileSync("src/lib/settings.ts", "utf8"),
  connectors: readFileSync("src/components/settings/ConnectorsTab.tsx", "utf8"),
  connectionEditor: readFileSync("src/components/ConnectionEditor.tsx", "utf8"),
  connectionsTab: readFileSync("src/components/settings/ConnectionsTab.tsx", "utf8"),
  shellxagentTab: readFileSync("src/components/settings/ShellxagentTab.tsx", "utf8"),
  tasksPanel: readFileSync("src/components/TasksPanel.tsx", "utf8"),
  workPreview: readFileSync("src/components/WorkPreviewPanel.tsx", "utf8"),
  builtinDocs: readFileSync("src/lib/builtin-docs.ts", "utf8"),
  userStore: readFileSync("src/lib/userStore.ts", "utf8"),
  apiDocs: readFileSync("docs/public/API.md", "utf8"),
  debugApi: readRustModuleFamily("src-tauri/src/debug_api.rs"),
  outsideConnectorRuntime: readFileSync("src-tauri/src/outside_connector_runtime.rs", "utf8"),
  hostMcp:
    readFileSync("src-tauri/src/host_mcp.rs", "utf8") +
    readdirSync("src-tauri/src/host_mcp", { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".rs"))
      .sort()
      .map((file) => readFileSync(`src-tauri/src/host_mcp/${file}`, "utf8"))
      .join("\n"),
  subagent: readFileSync("src-tauri/src/subagent.rs", "utf8"),
  backend: readFileSync("src-tauri/src/lib.rs", "utf8"),
  debugSurfaceTest: readFileSync("scripts/test-debug-ui-surfaces.ts", "utf8"),
};

function providerConnectorDispatchContract(runtime: string, debugApi: string): boolean {
  return debugApi.includes("ProviderSessionRegistry") &&
    debugApi.includes("provider_session_info_from_run") &&
    runtime.includes("dispatch_prompt_to_shellx_tab") &&
    runtime.includes("dispatch_prompt_to_provider_tab") &&
    runtime.includes("start_provider_session(registry, request, emit)") &&
    runtime.includes("state_for_tab_preferred(tab_id)") &&
    runtime.includes(".stored_conversations") &&
    runtime.includes(".get(&previous_run.provider_id)") &&
    runtime.includes("let resume = provider_conversation_id.is_some()") &&
    runtime.includes("shellx_tool_exposure: Some(run.shellx_tool_exposure)") &&
    runtime.includes("permission_mode: Some(run.permission_mode.clone())") &&
    runtime.includes("ssh_remote_runtime: run.ssh_remote_runtime");
}

assert(files.app.includes("Connect agent session"));
assert(files.app.includes("Ask active agent to fix current preview"));
assert(files.app.includes("report sent to the active agent"));
assert(files.header.includes("agents working"));
assert(
  files.header.includes('data-debug-id="header-shellx-browser"') &&
    files.header.includes('ShellIcon name="browser-orbit"'),
  "ShellX Browser header launcher must use the dedicated browser-orbit product glyph",
);
assert(
  files.header.includes('title="ShellX Browser"') &&
    files.header.includes('aria-label="Open ShellX Browser"'),
  "ShellX Browser header launcher must keep accessible label and tooltip",
);
assert(
  files.header.includes("onOpenBrowser") &&
    files.app.includes("onOpenBrowser={handleOpenShellxBrowser}"),
  "ShellX Browser header launcher must stay wired to the desktop browser opener",
);
assert(
  files.header.indexOf('aria-label="Open ShellX Browser"') <
    files.header.indexOf('aria-label="Open connector inbox"'),
  "ShellX Browser header launcher must render before the connector inbox launcher",
);
assert(files.connectors.includes("send to session"));
assert(files.connectors.includes("returns the active session reply"));
assert(
  files.connectors.includes('aria-label="Connector session chat approval"')
    && files.connectors.includes('data-debug-id="connector-approval-review-first"')
    && files.connectors.includes('data-debug-id="connector-approval-auto-dispatch"')
    && files.connectors.includes('dispatchMode: "autoPrompt" }))')
    && !files.connectors.includes('dispatchMode: "autoPrompt", requireApproval: false')
    && !files.connectors.includes('dispatchMode: "inbox", requireApproval: true'),
  "connector delivery and per-message approval must remain independent controls",
);
assert(
  providerConnectorDispatchContract(files.outsideConnectorRuntime, files.debugApi),
  "every provider session advertised by the connector picker must retain a real provider dispatch route and its execution policy",
);
assert(
  !providerConnectorDispatchContract(
    files.outsideConnectorRuntime.replace(
      "start_provider_session(registry, request, emit)",
      "provider dispatch removed",
    ),
    files.debugApi,
  ),
  "provider connector dispatch guard must fail when its executable provider start route is removed",
);
assert(
  files.connectors.includes("const desktopConnectorsAvailable = inTauri()") &&
    files.connectors.includes("This connector editor is a visual preview") &&
    files.connectors.includes("disabled={busy || !desktopConnectorsAvailable || debugFixtureActive}") &&
    files.connectors.includes("const canSave = !debugFixtureActive") &&
    files.connectors.includes("const canSimulate = !debugFixtureActive"),
  "browser preview must disclose unavailable connector IPC and disable persistence actions",
);
assert(
  files.connectionsTab.includes("const desktopConnectionsAvailable = inTauri()") &&
    files.connectionsTab.includes("disabled={busy || !desktopConnectionsAvailable}") &&
    files.connectionsTab.includes('role={desktopConnectionsAvailable ? "alert" : "status"}'),
  "browser preview must disclose unavailable connection IPC and disable refresh actions",
);
assert(
  files.bottomPanel.includes('lazy(() => import("./ConnectionEditor")') &&
    files.bottomPanel.includes("{connectionEditorOpen && (") &&
    files.connectionsTab.includes('lazy(() => import("../ConnectionEditor")') &&
    files.connectionsTab.includes("{editing !== null && (") &&
    files.bottomPanel.includes('label="Connection editor"') &&
    files.connectionsTab.includes('label="Connection editor"'),
  "both connection-editor entry points must retain a recoverable on-demand boundary",
);
assert(
  files.connectionEditor.includes('className="settings-close"') &&
    files.connectionEditor.includes('className="settings-pill active"') &&
    (files.connectionEditor.match(/className="settings-pill"/g)?.length ?? 0) >= 2,
  "connection editor chrome and footer actions must use the shared ShellX dialog language",
);
assert(
  files.shellxagentTab.includes('import { inTauri } from "../../lib/tauri-bridge"') &&
    files.shellxagentTab.includes("const desktopAgentAvailable = fixtureActive || inTauri()") &&
    files.shellxagentTab.includes("shellXagent token and bound-port controls are unavailable") &&
    files.shellxagentTab.includes("disabled={loading || !desktopAgentAvailable || fixtureActive}"),
  "browser preview must disclose unavailable shellXagent IPC and disable token rotation",
);
assert(files.tasksPanel.includes("Ask the active agent to inspect"));
assert(
  files.tasksPanel.includes('t.origin === "grok" && activeAgentId && activeAgentId !== "grok"') &&
    files.rightRail.includes("activeAgentId={activeAgentId ?? null}"),
  "Tasks panel must not show Grok child rows as active provider-tab background work",
);
assert(files.workPreview.includes("ask the active agent to fix"));
assert(files.builtinDocs.includes("return the active session reply"));
assert(
  files.builtinDocs.includes("Windows OpenSSH, run Windows agents") &&
    files.builtinDocs.includes("WSL is not required") &&
    !files.builtinDocs.includes("native PowerShell agent execution remains a separate future runtime"),
  "in-app connection docs must describe the shipped native Windows OpenSSH runtime",
);
assert(files.apiDocs.includes("target ShellX session"));

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const open = source.indexOf("{", start);
  assert(open >= 0, `missing function body for ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`unterminated function body for ${name}`);
}

assert(!functionBody(files.app, "handleNewTab").includes("connect("), "new tabs must not auto-connect to an agent");
assert(!files.app.includes("handleOpenProject"), "retired project-open wiring must not silently create agent tabs");
assert(!functionBody(files.app, "newTabEntry").includes("agentId"), "new tabs must not default the selected agent to Grok");
assert(files.app.includes("Choose an agent before sending."), "normal sends must require an explicit agent selection");
assert(
  files.app.includes("const selectedAgentForTab = normalizeAgentSelection(activeTab?.agentId);") &&
    files.app.includes("latestAgentForActiveTab ?? selectedAgentForTab;") &&
    files.app.includes("Choose an agent to see token usage.") &&
    files.app.includes('tok-provider-label">no agent'),
  "fresh unselected tabs must not render Grok context-window token copy",
);
assert(
  files.app.includes('if (agentId !== "grok" && !releaseTestBoundary) return null;') &&
    !files.app.includes("Grok artifact archive is only available on Grok tabs"),
  "Grok artifact archive control must not render as disabled Grok copy on provider tabs",
);
assert(
  files.app.includes("activeAgentId={activeAgentForControls}"),
  "RightRail must receive the tab-selected agent instead of the latest handoff speaker",
);
assert(
  files.app.includes("agentProviderScan={activeAgentProviderScan}"),
  "composer agent picker must consume active scan results, not stale saved connection data only",
);
assert(
  files.app.includes("onProviderScanUpdated={handleProviderScanUpdated}"),
  "RightRail provider scans must report back to App so the composer can update",
);
assert(
  files.app.includes("scanConnectionProvidersForPreset(preset)"),
  "selecting a connection must trigger an agent CLI scan without auto-connecting",
);
assert(
  files.app.includes("const preset = activeConnectionPreset ?? currentLocalConnectionPreset();")
    && files.app.includes("scanConnectionProvidersForPreset(preset);")
    && files.app.includes('window.addEventListener("focus", refreshWhenVisible)')
    && files.app.includes('document.addEventListener("visibilitychange", refreshWhenVisible)'),
  "agent CLI versions must refresh before launch and when ShellX regains visibility",
);
assert(
  !files.rightRail.includes("completedAutoScanKeys") &&
    !files.rightRail.includes("void refreshScan();"),
  "right rail must not auto-scan agent CLIs on mount or tab changes",
);
assert(
  files.app.includes("startedPatch.cwd = started.run.cwd"),
  "provider starts must adopt the normalized provider cwd into tab state",
);
assert(
  files.app.includes("function tabPatchChanges(tab: TabEntry, patch: Partial<TabEntry>): boolean") &&
    files.app.includes("if (!tabPatchChanges(t, patch)) return t") &&
    files.app.includes("const openTabsDebugKeyRef = useRef<string>(\"\")") &&
    files.app.includes("if (openTabsDebugKeyRef.current === key) return") &&
    files.app.includes("return changed ? next : prev"),
  "tab patch helpers must no-op when values are unchanged to avoid debug openTabs event spam",
);
assert(
  files.app.includes("function isUnixAbsoluteCwd(path: string): boolean") &&
    files.app.includes('return isUnixAbsoluteCwd(currentCwd) ? currentCwd : "/"') &&
    files.app.includes('activeTab.connectionTransport === "local"') &&
    files.app.includes('updateTabById(activeTab.tabId, { cwd: next })'),
  "non-local tabs must normalize stale relative cwd values before Files/cwd browsing",
);
assert(
  files.app.includes("RemoteFolderPickerModal") &&
    files.app.includes('invoke<RemoteFolderEntry[]>("list_project_files"') &&
    files.app.includes('if (pickerTransport !== "local")') &&
    files.app.includes("disabled={!canUsePath}") &&
    files.folderPath.includes("wslUnc") &&
    files.app.includes("normalizeRemoteFolderPath") &&
    files.app.includes('data-debug-id="remote-cwd-input"') &&
    files.app.includes('data-debug-id="remote-cwd-go"') &&
    files.app.includes('data-debug-id="remote-cwd-use"') &&
    files.app.includes('data-debug-id="remote-cwd-folder"'),
  "non-local cwd picker must use validated remote listing and normalize WSL UNC paths",
);
assert(
    files.app.includes("const cwdPickerPatch = p.cwdPicker") &&
    files.app.includes("if (p.preview && typeof p.preview === \"object\")") &&
    files.app.includes("const requestedTabId = typeof target.tabId === \"string\"") &&
    files.app.includes("const requestedSessionCwd = typeof target.sessionCwd === \"string\"") &&
    files.app.includes("setPreviewPath(path)") &&
    files.app.includes("setPreviewFileContext({ tabId, sessionCwd })") &&
    files.app.includes("if (previewFileContext?.tabId) ids.add(previewFileContext.tabId)") &&
    files.app.includes("const transientPatchFromEvent = (patch: unknown)") &&
    files.app.includes("apiGet<Record<string, unknown>>(\"/state/ui\")") &&
    files.app.includes("applyPatch({ ...state, ...transientPatchFromEvent(eventPatch) })") &&
    files.debugApi.includes("pub tab_id: Option<String>") &&
    files.debugApi.includes("pub session_cwd: Option<String>") &&
    files.app.includes("setRemoteFolderPicker({") &&
    files.app.includes("const openModalPatch = normalizeDebugModal(p.openModal)") &&
    files.app.includes("const composerMenuPatch = normalizeComposerDebugMenu(p.composerMenu)") &&
    files.app.includes("runDebugClickSelector(debugClickPatch)") &&
    files.bottomPanel.includes('export type { BottomTab, ComposerDebugMenu } from "../lib/ui-navigation"') &&
    files.uiNavigation.includes("export type ComposerDebugMenu") &&
    files.uiNavigation.includes("export const DEBUG_MODAL_IDS") &&
    files.bottomPanel.includes("debugOpenMenu === \"connection\"") &&
    files.debugApi.includes("pub composer_menu: Option<String>") &&
    files.debugApi.includes("pub open_modal: Option<String>") &&
    files.debugApi.includes("pub debug_click: Option<serde_json::Value>") &&
    files.debugApi.includes("pub debug_input: Option<serde_json::Value>") &&
    files.debugApi.includes("pub click_selector: Option<serde_json::Value>") &&
    files.debugApi.includes('pub cwd_picker: Option<serde_json::Value>') &&
    files.app.includes("attemptDebugClickSelector(") &&
    files.app.includes("deadlineMs") &&
    files.apiDocs.includes('composerMenu?: "connection" | "agent" | "branch" | "close"') &&
    files.apiDocs.includes("openModal?:") &&
    files.apiDocs.includes("cwdPicker?: true") &&
    files.apiDocs.includes("activeTab: {") &&
    files.apiDocs.includes("connectionId?: string; // explicit Local/WSL/SSH preset for listing") &&
    files.apiDocs.includes("Full Auto") &&
    files.apiDocs.includes("debugClick?: string") &&
    files.apiDocs.includes("debugInput?:"),
  "debug API must be able to open user-facing UI surfaces for screenshot-driven QA",
);
assert(
  !files.app.includes("lastDebugUiPatchMs = Math.max(lastDebugUiPatchMs, state.lastUiPatchMs)"),
  "state polling must not advance the debug UI event cursor past transient click/input commands",
);
assert(
    files.debugSurfaceTest.includes('{ name: "right-tasks", body: { rightTab: "Tasks" } }') &&
    files.debugSurfaceTest.includes('{ name: "right-files", body: { rightTab: "Files" } }') &&
    files.debugSurfaceTest.includes('{ name: "bottom-terminal", body: { bottomTab: "Terminal" } }') &&
    files.debugSurfaceTest.includes('{ name: "modal-settings", body: { openModal: "settings" }') &&
    files.debugSurfaceTest.includes('{ name: "modal-help", body: { openModal: "help" }') &&
    files.debugSurfaceTest.includes('{ name: "modal-plugins", body: { openModal: "plugins" }') &&
    files.debugSurfaceTest.includes('{ name: "modal-work-preview", body: { openModal: "workPreview" }') &&
    files.debugSurfaceTest.includes('{ name: "modal-build-plan-review-command", body: { openModal: "buildPlanReview" }') &&
    files.debugSurfaceTest.includes('{ name: "cwd-picker", body: { openModal: "close", cwdPicker: { path: "/", label: "Debug cwd" }') &&
    files.debugSurfaceTest.includes('name: "palette-filtered"') &&
    files.debugSurfaceTest.includes('name: "composer-typed"') &&
    files.debugSurfaceTest.includes('vaultRequestCenterOpen: false') &&
    files.debugSurfaceTest.includes('name: "composer-connection"') &&
    files.debugSurfaceTest.includes('{ name: "debug-click-preview-close", body: { debugClick: "button.preview-center-close" } }') &&
    files.debugSurfaceTest.includes('name: "click-selector-alias"') &&
    files.debugSurfaceTest.includes('await screenshot(base, token, outDir, name)'),
  "runtime debug UI surface test must drive /state/ui and capture /screenshot evidence",
);
assert(
    files.debugSurfaceTest.includes("expectedSelectors") &&
    files.debugSurfaceTest.includes("waitForDebugSelectors") &&
    files.debugSurfaceTest.includes("debugHighlightResults") &&
    files.debugSurfaceTest.includes(".settings-modal") &&
    files.debugSurfaceTest.includes("[data-debug-id='vault-workspace-modal']") &&
    files.debugSurfaceTest.includes("[data-debug-id='command-palette-input']"),
  "runtime debug UI surface test must assert requested surfaces are present before screenshot capture",
);
assert(
  files.debugSurfaceTest.includes('composerMenu: "connection"') &&
    files.debugSurfaceTest.includes('composerMenu: "close"') &&
    files.debugSurfaceTest.includes('debugClick: "button.preview-center-close"') &&
    files.debugSurfaceTest.includes('debugClick') &&
    files.debugSurfaceTest.includes('debugInput'),
  "runtime debug UI surface test must preserve stable screenshot-driven commands",
);
assert(
    files.backend.includes("provider_registry: State<'_, Arc<provider_sessions::ProviderSessionRegistry>>") &&
    files.backend.includes("pub(crate) async fn list_project_files_for_debug(") &&
    files.backend.includes(".preferred_execution_for_tab(&tab_key)") &&
    files.backend.includes("if let Some(connection_id) = explicit_connection_id.as_deref()") &&
    files.backend.indexOf("if let Some(connection_id) = explicit_connection_id.as_deref()") <
      files.backend.indexOf("provider_registry.preferred_execution_for_tab(&tab_key)") &&
    files.backend.includes("provider_file_target_for_connection_id(connection_id).await?") &&
    files.backend.includes("unknown connection_id") &&
    files.backend.includes("return list_provider_target_project_files(") &&
    files.backend.includes("return list_local_project_files(&pb, &path, include_hidden);") &&
    files.backend.includes("list_provider_wsl_project_files") &&
    files.backend.includes("list_provider_ssh_project_files") &&
    files.filesPane.includes("connectionId: connectionId ?? undefined") &&
    files.app.includes("connectionId: request.connectionId ?? undefined"),
  "Files panel backend must use provider-session or selected connection transport context for WSL/SSH tabs",
);
assert(
  files.app.includes('selectedAgentForSlash !== "grok"') &&
    files.app.includes("eventsForActiveTab.length - 1"),
  "slash autocomplete must read Grok available_commands only for the active Grok tab",
);
const connectAgentGuardIndex = files.app.indexOf("const targetAgent = normalizeAgentSelection(targetTab?.agentId)");
const connectProviderGuardIndex = files.app.indexOf("isProviderAgent(targetAgent)");
const connectGrokStartIndex = files.app.indexOf('invoke<string>("start_grok_session"');
assert(
  connectAgentGuardIndex >= 0 &&
    connectProviderGuardIndex > connectAgentGuardIndex &&
    connectGrokStartIndex > connectProviderGuardIndex &&
    files.app.includes("Choose an agent before connecting.") &&
    files.app.includes("Connect is for Grok sessions."),
  "generic Connect must not silently start Grok on unselected or provider tabs",
);
assert(
  files.uiNavigation.includes("function normalizeRightTabPatch") &&
    files.uiNavigation.includes("function normalizeBottomTabPatch") &&
    files.app.includes("normalizeRightTabPatch(p.rightTab)") &&
    files.app.includes("normalizeBottomTabPatch(p.bottomTab)"),
  "debug API UI tab patches must accept lowercase/canonical tab names before driving renderer state",
);
assert(
  files.app.includes('apiPost("/state/ui", { bottomTab, source: "renderer" })'),
  "renderer must mirror canonical bottom tab names back to debug API state",
);
assert(
  files.app.includes("const openTabs = tabs.map((t) => ({") &&
    files.app.includes('apiPost("/state/ui", { openTabs, source: "renderer" })'),
  "renderer must mirror open tab metadata for debug API multi-agent tab reports",
);
assert(
  files.debugApi.includes('.route("/state/tabs/report", get(state_tabs_report))') &&
    files.debugApi.includes("fn debug_tab_report_from_parts") &&
    files.debugApi.includes("open_tabs: Vec<UiOpenTabContext>"),
  "debug API must expose a compact active-tab report without scraping screenshots",
);
assert(
  files.apiDocs.includes("GET /state/tabs/report"),
  "debug API active-tab report must be documented for QA agents",
);
assert(
  files.debugApi.includes("fn normalize_right_tab_wire") &&
    files.debugApi.includes("fn normalize_bottom_tab_wire") &&
    files.debugApi.includes("normalize_right_tab_wire(&t).unwrap_or(t)") &&
    files.debugApi.includes("normalize_bottom_tab_wire(&t).unwrap_or(t)"),
  "debug API must store canonical tab names even when a no-op renderer state change cannot repost them",
);
assert(
  files.debugApi.includes("ui_revision") &&
    files.debugApi.includes("last_ui_patch_source") &&
    files.debugApi.includes("active_tab_for_id_from_open_tabs") &&
    files.debugApi.includes("allow_build_tab_mutation") &&
    files.debugApi.includes("debug-ui-state-patch: refusing Build tab context mutation"),
  "debug API must keep UI tab context coherent and expose mutation metadata for screenshot-driven automation",
);
assert(
  files.hostMcp.includes("create_build_agent_checkpoint_via_session_git") &&
    files.hostMcp.includes("post_build_checkpoint_to_debug_api") &&
    !files.hostMcp.includes("create_direct_build_agent_checkpoint(cwd, tab, label).await"),
  "Build Agent auto-checkpoints must use the transport-aware session Git checkpoint path, not direct local git",
);
assert(
  files.subagent.includes("Avoid broad machine scans such as `find /`") &&
    files.subagent.includes("prefer `rg --files`") &&
    files.subagent.includes("scope discovery to the assigned project cwd"),
  "subagent runtime guard must discourage broad root filesystem scans during Build Mode",
);
const buildCommandIndex = files.app.indexOf("const buildObjective = parseBuildCommand(currentPrompt)");
const buildAgentGuardIndex = files.app.indexOf("const selectedAgentForBuild = normalizeAgentSelection(activeTab?.agentId)");
const buildAutoConnectIndex = files.app.indexOf("auto-connect (build-mode start)");
assert(buildCommandIndex >= 0 && buildAgentGuardIndex > buildCommandIndex && buildAutoConnectIndex > buildAgentGuardIndex,
  "/build must require Grok selection before auto-connect can start a Grok session");
assert(
  files.bottomPanel.includes("Agent: {agentSelectionShortLabel(selectedAgentId)}") &&
    files.bottomPanel.includes("Choose an agent before sending"),
  "composer must show a neutral choose-agent state before first send",
);
assert(
  !files.bottomPanel.includes('selectedAgentId ?? "grok"'),
  "composer helper text must not fall back to Grok before an agent is selected",
);
assert(
  !files.bottomPanel.includes("className={`autonomy-chip") &&
    !files.bottomPanel.includes("Currently Auto") &&
    !files.bottomPanel.includes("Currently Confirm"),
  "composer must not expose provider permission/autonomy as a primary chat-box selector",
);
assert(
  files.bottomPanel.includes("Scanning this environment for agent CLIs") &&
    !files.bottomPanel.includes("return AGENT_OPTIONS;"),
  "agent picker must not show every provider before the active environment scan finishes",
);
assert(
  files.bottomPanel.includes("stderrLineFromEvent") &&
    files.bottomPanel.includes('e.kind !== "provider-session-event"') &&
    files.bottomPanel.includes('payload.rawType !== "stderr"'),
  "Stderr tab must include provider raw stderr, not only grok-stderr",
);
assert(!files.connectionEditor.includes("Grok Build CLI override"), "connection editor must not expose Grok-specific CLI path overrides");
assert(!files.connectionEditor.includes("Advanced CLI overrides"), "connection editor must not expose hidden CLI override controls");
assert(!files.connectionsTab.includes("remoteGrokPath ?"), "connections list must not display saved Grok path overrides");
assert(files.rightRail.includes("Search capabilities"), "Tools capability section must be provider-neutral");
assert(files.rightRail.includes("? \"NATIVE\" : \"HOST\""), "native capability badge must not be labelled Grok on provider tabs");
assert(files.rightRail.includes("ShellX tools"), "Tools pane must expose per-tab ShellX tool exposure controls");
assert(files.rightRail.includes("tool-exposure-segments"), "ShellX tool exposure control must use a compact segmented control");
assert(
  files.rightRail.includes('lazy(() => import("./GitPane")') &&
    files.rightRail.includes('lazy(() => import("./WorkPreviewPanel")') &&
    files.rightRail.includes('lazy(() => import("./FilesPane")') &&
    files.rightRail.includes('label="Git panel"') &&
    files.rightRail.includes('label="Preview panel"') &&
    files.rightRail.includes('label="Files panel"') &&
    (files.rightRail.match(/onDismiss=\{\(\) => setTab\("Tasks"\)\}/g)?.length ?? 0) === 3,
  "non-default operational right-rail panels must retain recoverable on-demand boundaries",
);
assert(
  files.rightRail.includes('lazy(() => import("./AgentCliStatusCard")')
    && (files.rightRail.match(/label="Agent CLI status" variant="inline"/g)?.length ?? 0) === 2,
  "non-default Tooling views must load Agent CLI status behind a recoverable boundary",
);
assert(
  files.rightRail.includes('lazy(() => import("./BuildRunCockpit")')
    && files.rightRail.includes("renderedBuildState && (")
    && files.rightRail.includes('label="Build Mode cockpit" variant="inline"'),
  "Plan must load the Build Mode cockpit only for an observed build run and retain local recovery",
);
assert(files.builtinDocs.includes("Provider tabs only show commands"), "built-in help must explain provider-scoped slash commands");
assert(!files.builtinDocs.includes("grok's slash commands"), "built-in help must not call all slash commands Grok commands");
assert(files.settings.includes('const STORAGE_KEY = "shellX.settings.v2"'), "settings must write new data under the ShellX namespace");
assert(files.settings.includes('export const TAB_KEY = "shellX.settingsTab.v2"'), "settings active tab must write under the ShellX namespace");
assert(files.bottomPanel.includes('const TAB_KEY = "shellX.bottomTab.v2"'), "bottom tab persistence must write under the ShellX namespace");
assert(files.rightRail.includes('export const RIGHT_RAIL_TAB_KEY = "shellX.rightTab.v2"'), "right rail persistence must write under the ShellX namespace");
assert(files.userStore.includes('export const SESSION_TABS_KEY = "shellX.session-tabs.v3"'), "session tab persistence must write under the ShellX namespace");
assert(files.app.includes('const PANEL_SIZE_KEY_H = "shellX.panels.horizontal"'), "panel width persistence must write under the ShellX namespace");
assert(files.app.includes('const PANEL_SIZE_KEY_V = "shellX.panels.vertical"'), "panel height persistence must write under the ShellX namespace");
assert(files.app.includes('const PANEL_AUTOSAVE_ID_H = "shellX-h"'), "panel autosave ids must use the ShellX namespace");
assert(!files.app.includes('localStorage.setItem("grok-shell.settingsTab.v1"'), "App must not directly write the legacy Settings tab key");
assert(!files.app.includes('autoSaveId="grok-shell-'), "App must not keep writing Grok-named panel autosave ids");
assert(
  files.settings.includes('const LEGACY_STORAGE_KEY = "grok-shell.settings.v1"') &&
    files.settings.includes('const LEGACY_TAB_KEY = "grok-shell.settingsTab.v1"') &&
    files.bottomPanel.includes('const LEGACY_TAB_KEY = "grok-shell.bottomTab"') &&
    files.rightRail.includes('const LEGACY_RIGHT_RAIL_TAB_KEY = "grok-shell.rightTab"') &&
    files.userStore.includes('export const LEGACY_SESSION_TABS_KEY = "grok-shell.session-tabs.v2"') &&
    files.app.includes('const LEGACY_PANEL_SIZE_KEY_H = "grok-shell.panels.horizontal"') &&
    files.app.includes('const LEGACY_PANEL_SIZE_KEY_V = "grok-shell.panels.vertical"') &&
    files.app.includes('["grok-shell-h", PANEL_AUTOSAVE_ID_H]'),
  "legacy Grok-named storage keys must remain as migration-only fallbacks",
);

const forbiddenGenericUiCopy = [
  "Connect grok session",
  "Connected to Grok session",
  "Grok capabilities",
  "Ask Grok to fix current preview",
  "report sent to Grok",
  "send to Grok",
  "returns Grok's text reply",
  "grok wants to run a shell command",
  "groks working",
  "each grok subprocess",
];

for (const text of forbiddenGenericUiCopy) {
  for (const [name, source] of Object.entries(files)) {
    assert(!source.includes(text), `${name} should not contain generic Grok-only UI copy: ${text}`);
  }
}

console.log("test-provider-neutral-ui ok");
