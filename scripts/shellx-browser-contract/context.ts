import { readdirSync, statSync } from "node:fs";
import { readRustModuleFamily } from "../read-rust-module-family";
import { readNormalizedTextFileSync as readFileSync } from "../lib/text-content";
export let failures = 0;
export function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}
export function readRequiredSource(path: string): string {
  const stat = statSync(path);
  return stat.isFile() ? readFileSync(path) : "";
}
console.log("\n=== shellx browser module ===");
export const rustBrowserRoot = readFileSync("src-tauri/src/shellx_browser.rs");
export const rustBrowser = readRustModuleFamily("src-tauri/src/shellx_browser.rs") + readdirSync("src-tauri/src/shellx_browser_tests").sort().map((file) => readRequiredSource(`src-tauri/src/shellx_browser_tests/${file}`)).join("\n");
export const rustBrowserDestructiveActions = readFileSync("src-tauri/src/shellx_browser_destructive_actions.rs");
export const rustBrowserDeveloperMode = readFileSync("src-tauri/src/shellx_browser_developer_mode.rs");
export const rustBrowserPersonalLock = readRequiredSource("src-tauri/src/shellx_browser_personal_lock.rs");
export const rustBrowserPersistence = readRequiredSource("src-tauri/src/shellx_browser_persistence.rs");
export const rustBrowserModel = ["src-tauri/src/shellx_browser_model.rs", "src-tauri/src/shellx_browser_settings_model.rs", "src-tauri/src/shellx_browser_engine_model.rs", "src-tauri/src/shellx_browser_artifact_model.rs", "src-tauri/src/shellx_browser_observation_model.rs", "src-tauri/src/shellx_browser_task_model.rs"].map(readRequiredSource).join("\n");
export const browserActionResultsSource = readRequiredSource("src-tauri/src/shellx_browser_action_results.rs") + readRequiredSource("src-tauri/src/shellx_browser_taskless_action_results.rs");
export const browserActionScriptSource = readRequiredSource("src-tauri/src/shellx_browser_action_script.rs");
export const browserCoordinateInputSource = readRequiredSource("src-tauri/src/shellx_browser_coordinate_input.rs");
export const browserActionsSource = readRequiredSource("src-tauri/src/shellx_browser_actions.rs") + readRequiredSource("src-tauri/src/shellx_browser_screenshot_capture.rs");
export const browserObservationsSource = readRequiredSource("src-tauri/src/shellx_browser_observations.rs");
export const browserBookmarksSource = readRequiredSource("src-tauri/src/shellx_browser_bookmarks.rs") + readRequiredSource("src-tauri/src/shellx_browser_history.rs");
export const browserCdpRuntimeSource = readRequiredSource("src-tauri/src/shellx_browser_cdp_runtime.rs");
export const browserEngineSource = readRequiredSource("src-tauri/src/shellx_browser_engine.rs");
export const browserEngineRuntimeSource = ["src-tauri/src/shellx_browser_engine_runtime.rs", "src-tauri/src/shellx_browser_engine_lifecycle.rs", "src-tauri/src/shellx_browser_engine_webview_config.rs", "src-tauri/src/shellx_browser_initialization.rs", "src-tauri/src/shellx_browser_webview_runtime.rs"].map(readRequiredSource).join("\n");
export const permissionHandlerSource = browserEngineRuntimeSource.match(/&PermissionRequestedEventHandler::create\(Box::new\(move \|_sender, args\| \{[\s\S]*?&mut permission_token,/)?.[0] ?? "";
export const browserRenderedCheckSource = readRequiredSource("src-tauri/src/shellx_browser_rendered_check.rs");
export const browserVaultRuntimeSource = readRequiredSource("src-tauri/src/shellx_browser_vault.rs");
export const browserWindowOpenRuntimeSource = readRequiredSource("src-tauri/src/shellx_browser_window_open_runtime.rs");
export const browserEngineStateSource = readRequiredSource("src-tauri/src/shellx_browser_engine_state.rs");
export const browserScriptsSource = readRequiredSource("src-tauri/src/shellx_browser_scripts.rs") + readRequiredSource("src-tauri/src/shellx_browser_dom_traversal.rs");
export const browserSecuritySource = readRequiredSource("src-tauri/src/shellx_browser_security.rs");
export const browserTabsSource = readRequiredSource("src-tauri/src/shellx_browser_tabs.rs");
export const browserProtectedValuesSource = readRequiredSource("src-tauri/src/shellx_browser_protected_values.rs");
export const browserProfilesSource = readRequiredSource("src-tauri/src/shellx_browser_profiles.rs");
export const browserTasksSource = readRequiredSource("src-tauri/src/shellx_browser_tasks.rs") + readRequiredSource("src-tauri/src/shellx_browser_task_control.rs") + readRequiredSource("src-tauri/src/shellx_browser_caller.rs");
export const rustBrowserPrivacy = readFileSync("src-tauri/src/shellx_browser_privacy.rs", "utf8");
export const rustBrowserPrompts = readFileSync("src-tauri/src/shellx_browser_prompts.rs", "utf8");
export const rustBrowserSessionGrants = readFileSync("src-tauri/src/shellx_browser_session_grants.rs", "utf8");
export const rustBrowserShields = readFileSync("src-tauri/src/shellx_browser_shields.rs", "utf8") + readRequiredSource("src-tauri/src/shellx_browser_shield_settings.rs");
export const rustBrowserRobots = readRequiredSource("src-tauri/src/shellx_browser_robots.rs");
export const rustBrowserArtifacts = readRequiredSource("src-tauri/src/shellx_browser_artifacts.rs");
export const rustBrowserStorageState = readRequiredSource("src-tauri/src/shellx_browser_storage_state.rs");
export const rustBrowserState = readRequiredSource("src-tauri/src/shellx_browser_state.rs");
export const rustBrowserRecipes = readRequiredSource("src-tauri/src/shellx_browser_recipes.rs") + readRequiredSource("src-tauri/src/shellx_browser_recipe_analysis.rs");
export const rustBrowserReports = readRequiredSource("src-tauri/src/shellx_browser_reports.rs");
export const rustBrowserDiagnostics = readRequiredSource("src-tauri/src/shellx_browser_diagnostics.rs");
export const rustBrowserTransfers = readFileSync("src-tauri/src/shellx_browser_transfers.rs", "utf8");
export const rustBrowserTransferArtifacts = readRequiredSource("src-tauri/src/shellx_browser_transfer_artifacts.rs");
export const rustBrowserIntegrationTests = readRequiredSource("src-tauri/tests/shellx_browser.rs");
export const rustLib = readFileSync("src-tauri/src/lib.rs", "utf8");
export const rustBuildMetadata = readFileSync("src-tauri/src/build_metadata.rs", "utf8");
export const rustBuildScript = readFileSync("src-tauri/build.rs", "utf8");
export const debugApiRoot = readFileSync("src-tauri/src/debug_api.rs", "utf8");
export const debugApi = readRustModuleFamily("src-tauri/src/debug_api.rs");
export const debugApiBrowser = readRequiredSource("src-tauri/src/debug_api_browser.rs");
export const debugApiBrowserArtifactsSource = readRequiredSource("src-tauri/src/debug_api_browser_artifacts.rs") + readRequiredSource("src-tauri/src/debug_api_browser_recipe_replay.rs");
export const debugApiBrowserSecuritySource = readRequiredSource("src-tauri/src/debug_api_browser_security.rs");
export const debugApiBrowserStateSource = readRequiredSource("src-tauri/src/debug_api_browser_state.rs");
export const debugApiBrowserSettingsSource = readRequiredSource("src-tauri/src/debug_api_browser_settings.rs");
export const debugApiBrowserRouteSources = [
  debugApi,
  debugApiBrowser,
  debugApiBrowserArtifactsSource,
  debugApiBrowserSecuritySource,
  debugApiBrowserStateSource,
  debugApiBrowserSettingsSource,
];
export const hostMcp = readFileSync("src-tauri/src/host_mcp.rs", "utf8") + readdirSync("src-tauri/src/host_mcp", { recursive: true }).sort().map((file) => readRequiredSource(`src-tauri/src/host_mcp/${file}`)).join("\n");
export const pluginsModalSource = readFileSync("src/components/PluginsModal.tsx", "utf8");
export const subagentSource = readFileSync("src-tauri/src/subagent.rs", "utf8");
export const packageData = JSON.parse(readFileSync("package.json", "utf8")) as { version: string; scripts?: Record<string, string> };
export const testSuiteManifestSource = readFileSync("scripts/test-suite-manifest.mjs", "utf8");
export const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
export const tauriConf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as { version: string };
export const tauriConfSource = readFileSync("src-tauri/tauri.conf.json", "utf8");
export const tauriCapabilitiesSource = readFileSync("src-tauri/capabilities/default.json", "utf8");
export const mainSource = readFileSync("src/main.tsx", "utf8");
export const browserMainSource = readFileSync("src/shellx-browser-main.tsx", "utf8");
export const browserHtmlSource = readFileSync("shellx-browser.html", "utf8");
export const appSource = readFileSync("src/App.tsx", "utf8");
export const debugUiConnectionSource = readRequiredSource("src/lib/debug-ui-connection.ts");
export const uiSource = (() => {
  try {
    return readFileSync("src/components/ShellxBrowserApp.tsx", "utf8");
  } catch {
    return "";
  }
})();
export const browserTypesSource = readRequiredSource("src/browser/types.ts"), browserAppConstantsSource = readRequiredSource("src/browser/browserAppConstants.ts");
export const browserNativeSecurityNoticeSource = readRequiredSource("src/browser/components/BrowserNativeSecurityNotice.tsx");
export const browserPreferencesSource = readRequiredSource("src/browser/browserPreferences.ts"), browserHistoryClearSource = readRequiredSource("src/browser/historyClear.ts");
export const browserPresentationSource = readRequiredSource("src/browser/browserPresentation.ts");
export const browserDebugBridgeSource = readRequiredSource("src/browser/debugBridge.ts");
export const browserTaskIntentSource = readRequiredSource("src/browser/taskIntent.ts");
export const browserApiSource = readRequiredSource("src/browser/api.ts");
export const browserVaultFillCandidateSource = readRequiredSource("src/browser/vaultFillCandidates.ts");
export const browserShieldsPanelSource = readRequiredSource("src/browser/components/BrowserShieldsPanel.tsx");
export const browserMenusSource = readRequiredSource("src/browser/components/BrowserMenus.tsx");
export const browserHistorySidecarSource = readRequiredSource("src/browser/components/BrowserHistorySidecar.tsx");
export const downloadSidecarSource = readRequiredSource("src/browser/components/DownloadSidecar.tsx"), bookmarkSidecarSource = readRequiredSource("src/browser/components/BookmarkSidecar.tsx"), bookmarkToolbarSource = readRequiredSource("src/browser/components/BookmarkToolbar.tsx");
export const browserChromeSource = readRequiredSource("src/browser/components/BrowserChrome.tsx");
export const settingsModelSource = readRequiredSource("src/lib/settings.ts");
export const generalTabSource = readRequiredSource("src/components/settings/GeneralTab.tsx");
export const nativeEngineSyncSource = readRequiredSource("src/browser/hooks/useNativeEngineSync.ts");
export const browserStateHookSource = readRequiredSource("src/browser/hooks/useBrowserState.ts");
export const browserPageActionsSource = readRequiredSource("src/browser/hooks/useBrowserPageActions.ts"), browserBookmarkHookSource = readRequiredSource("src/browser/hooks/useBrowserBookmarks.ts"), browserPersonalLockSource = readRequiredSource("src/browser/hooks/useBrowserPersonalLock.ts"), browserVaultFillSource = readRequiredSource("src/browser/hooks/useBrowserVaultFill.ts"), browserVaultFillPanelSource = readRequiredSource("src/browser/components/BrowserVaultFillPanel.tsx"), browserTabsHookSource = readRequiredSource("src/browser/hooks/useBrowserTabs.ts"), browserTasksHookSource = readRequiredSource("src/browser/hooks/useBrowserTasks.ts"), browserShellEffectsSource = readRequiredSource("src/browser/hooks/useBrowserShellEffects.ts");
export const engineViewportSource = readRequiredSource("src/browser/components/EngineViewport.tsx");
export const agentSidebarSource = readRequiredSource("src/browser/components/AgentSidebar.tsx");
export const vaultPromptCardsSource = readRequiredSource("src/browser/components/VaultPromptCards.tsx");
export const uiSourceLower = uiSource.toLowerCase();
export const browserCssPaths = ["browserLayout.css", "browserWorkspace.css", "browserPanels.css", "browserShell.css"];
export const cssSource = browserCssPaths.map((path) => readFileSync(`src/browser/${path}`, "utf8")).join("\n");
export function cssBlock(selector: string): string {
  const start = cssSource.indexOf(`${selector} {`);
  if (start === -1) {
    return "";
  }
  const open = cssSource.indexOf("{", start);
  const close = cssSource.indexOf("}", open);
  return open === -1 || close === -1 ? "" : cssSource.slice(start, close + 1);
}
export const browserAppCss = cssSource.match(/\.shellx-browser-app\s*\{[^}]+\}/)?.[0] ?? "";
export const browserTopCss = cssBlock(".shellx-browser-top");
export const browserTabChromeCss = cssBlock(".shellx-browser-tab-chrome");
export const browserTabStripCss = cssBlock(".shellx-browser-tab-strip");
export const browserHeaderMenuWrapCss = cssBlock(".shellx-browser-header-menu-wrap");
export const browserHeaderPopoverCss = cssBlock(".shellx-browser-header-popover");
export const browserChromeShellCss = cssBlock(".shellx-browser-chrome-shell");
export const browserChromeMenuDockCss = cssBlock(".shellx-browser-chrome-menu-dock");
export const browserBookmarkToolbarCss = cssBlock(".shellx-browser-bookmark-toolbar");
export const browserExpandedAgentComposeCss = cssBlock(".shellx-browser-agent-panel.chat-expanded .shellx-browser-agent-compose");
export const readme = readFileSync("README.md", "utf8");
export const apiDocs = readFileSync("docs/public/API.md", "utf8");
export const moduleReadme = readFileSync("shellx-browser/README.md", "utf8");
export const shellxHostSkill = readFileSync("skills/shellx-host/SKILL.md", "utf8");
export const changelog = readFileSync("CHANGELOG.md", "utf8");
export const liveSmokeSource = readFileSync("scripts/test-shellx-browser-debug-api.ts", "utf8");
export const fixtureServerSource = readFileSync("scripts/fixtures/vault-browser-site/server.mjs", "utf8");
export const everydayFixtureSource = readRequiredSource("scripts/fixtures/vault-browser-site/public/everyday-apps.html");
export const everydayAppsSmokeSource = readRequiredSource("scripts/test-shellx-browser-everyday-apps.ts");
export const adversarySmokeSource = readRequiredSource("scripts/test-shellx-vault-adversary.ts");
export const concurrencySmokeSource = readRequiredSource("scripts/test-shellx-browser-concurrency.ts");
export const batchTimingSmokeSource = readRequiredSource("scripts/test-shellx-browser-batch-timing.ts");
export const workflowMatrixSmokeSource = readRequiredSource("scripts/test-shellx-browser-workflow-matrix.ts");
export const browserTestCleanupSource = readRequiredSource("scripts/shellx-browser-test-cleanup.ts");
export const browserCleanupTestSource = readRequiredSource("scripts/test-shellx-browser-cleanup.ts");
export const debugPathHelperSource = readRequiredSource("scripts/shellx-debug-paths.ts");
export const uiDebugSmokeSource = (() => {
  try {
    return readFileSync("scripts/test-shellx-browser-ui-debug.ts", "utf8");
  } catch {
    return "";
  }
})();
export const browserCliSource = (() => {
  try {
    return readFileSync("scripts/shellx-browser-cli.ts", "utf8");
  } catch {
    return "";
  }
})();
export const skillInstallSource = readFileSync("src-tauri/src/skill_install.rs", "utf8");


export function finishShellxBrowserContract(): void {
  if (failures > 0) {
    console.error(`\n${failures} ShellX Browser check(s) failed.`);
    process.exit(1);
  }
  console.log("ShellX Browser checks passed");
}
