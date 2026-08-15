import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";
import { normalizeDebugHighlightRequests } from "../src/lib/debug-highlight-normalization";
import { readAppStyles } from "./lib/app-styles";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== debug highlight overlay ===");

const appSource = readFileSync("src/App.tsx", "utf8");
const browserDebugBridgeSource = readFileSync("src/browser/debugBridge.ts", "utf8");
const overlaySource = (() => {
  try {
    return readFileSync("src/components/DebugHighlightOverlay.tsx", "utf8");
  } catch {
    return "";
  }
})();
const observationSource = readFileSync("src/lib/debug-element-observation.ts", "utf8");
const headerSource = readFileSync("src/components/Header.tsx", "utf8");
const connectorsSource = readFileSync("src/components/settings/ConnectorsTab.tsx", "utf8");
const rightRailSource = readFileSync("src/components/RightRail.tsx", "utf8");
const gitPaneSource = readFileSync("src/components/GitPane.tsx", "utf8");
const permissionPillSource = readFileSync("src/components/PermissionPill.tsx", "utf8");
const sessionTabsSource = readFileSync("src/components/SessionTabs.tsx", "utf8");
const tasksPanelSource = readFileSync("src/components/TasksPanel.tsx", "utf8");
const installedInputSource = readFileSync("scripts/lib/release-surface-installed-input-client.ts", "utf8");
const cssSource = readAppStyles();
const bottomPanelSource = readFileSync("src/components/BottomPanel.tsx", "utf8");
const settingsSource = readFileSync("src/components/Settings.tsx", "utf8");
const generalSettingsSource = readFileSync("src/components/settings/GeneralTab.tsx", "utf8");
const attachmentBoardSource = readFileSync("src/components/AttachmentMediaBoard.tsx", "utf8");
const downloadSidecarSource = readFileSync("src/browser/components/DownloadSidecar.tsx", "utf8");
const buildRunCockpitSource = readFileSync("src/components/BuildRunCockpit.tsx", "utf8");
const chatOutputSource = readFileSync("src/components/ChatOutput.tsx", "utf8");
const previewCenterSource = readFileSync("src/components/PreviewCenter.tsx", "utf8");
const previewCenterCss = readFileSync("src/components/PreviewCenter.css", "utf8");
const filePreviewSource = readFileSync("src/components/FilePreviewModal.tsx", "utf8");
const micButtonSource = readFileSync("src/components/MicButton.tsx", "utf8");
const prCreateSource = readFileSync("src/components/PRCreateModal.tsx", "utf8");
const debugApiSource = readRustModuleFamily("src-tauri/src/debug_api.rs");
const apiDocs = readFileSync("docs/public/API.md", "utf8");
const surfaceSweep = readFileSync("scripts/test-debug-ui-surfaces.ts", "utf8");

assert(appSource.includes("debugHighlights"), "renderer receives debugHighlights patches");
assert(
  JSON.stringify(normalizeDebugHighlightRequests([{
    selector: " [data-debug-id='composer-prompt'] ",
    observe: ["title", "secret", "title", "focused", "href"],
  }])) === JSON.stringify([{
    selector: "[data-debug-id='composer-prompt']",
    observe: ["title", "focused", "href"],
  }]),
  "renderer normalization preserves only unique allowlisted observation fields",
);
assert(
  appSource.includes("normalizeDebugHighlightRequests(p.debugHighlights)")
    && browserDebugBridgeSource.includes("return normalizeDebugHighlightRequests(value)"),
  "app and browser renderers both retain the shared bounded observation request",
);
assert(appSource.includes("<DebugHighlightOverlay"), "renderer mounts the debug highlight overlay");
assert(
  previewCenterSource.includes('import "./PreviewCenter.css";')
    && previewCenterCss.includes(".preview-center-modal")
    && previewCenterCss.includes(".preview-center-switcher button.active"),
  "lazy Preview Center owns its complete shell and mode-switcher styles",
);
assert(overlaySource.includes("getBoundingClientRect"), "overlay positions borders from real DOM rectangles");
assert(overlaySource.includes("ResizeObserver"), "overlay remeasures when target layout changes");
assert(overlaySource.includes("MutationObserver"), "overlay remeasures when target visibility changes");
assert(overlaySource.includes("debugHighlightResults"), "overlay reports resolved and missing targets");
assert(overlaySource.includes("observeDebugElement"), "overlay uses the bounded element-observation contract");
assert(observationSource.includes("data-shellx-release-observe"), "bounded observations require explicit element declarations");
assert(
  observationSource.includes('["password", "hidden", "file"]') &&
    observationSource.includes("data-shellx-sensitive='true'") &&
    observationSource.includes("one-time-code"),
  "bounded value observations fail closed for secret-bearing controls",
);
assert(
  observationSource.includes('field === "title"')
    && observationSource.includes("element.closest(\"[data-shellx-sensitive='true']\")"),
  "bounded title observations fail closed below explicitly sensitive owners",
);
assert(
  observationSource.includes('field === "href"')
    && observationSource.includes("element instanceof HTMLAnchorElement")
    && observationSource.includes('/^https:\\/\\//i'),
  "bounded href observations expose only explicitly declared HTTPS anchors",
);
assert(
  observationSource.includes('field === "nonempty"')
    && observationSource.includes("element.value.length > 0"),
  "bounded nonempty observations expose only a boolean sensitive-draft transition",
);
assert(headerSource.includes('data-shellx-release-observe="pressed"'), "theme toggle declares only its safe pressed observation");
assert(
  connectorsSource.includes("data-provider-kind={providerKind}")
    && connectorsSource.includes('data-shellx-release-observe="selected"'),
  "Connectors provider tabs declare only their non-sensitive selected observation",
);
assert(
  (connectorsSource.match(/data-shellx-release-observe="pressed"/g) ?? []).length === 6,
  "Connectors receiver, approval, and delivery buttons declare six non-sensitive pressed observations",
);
assert(
  (connectorsSource.match(/data-shellx-release-observe="value"/g) ?? []).length === 3
    && /id="connector-target"[\s\S]{0,160}data-shellx-release-observe="value"/.test(connectorsSource)
    && /data-debug-id="surface-components-settings-connectorstab-11"[\s\S]{0,160}data-shellx-release-observe="value"/.test(connectorsSource)
    && /id="connector-sim-connector"[\s\S]{0,160}data-shellx-release-observe="value"/.test(connectorsSource),
  "Connectors exposes only target, fixed-session, and simulator connector identity as bounded values and never its Vault key, allowlist, or secret drafts",
);
assert(
  (connectorsSource.match(/data-shellx-release-observe="nonempty"/g) ?? []).length === 6
    && /id="connector-secret"[\s\S]{0,160}data-shellx-release-observe="nonempty"/.test(connectorsSource)
    && /id="connector-allowed"[\s\S]{0,160}data-shellx-release-observe="nonempty"/.test(connectorsSource)
    && /id="connector-sim-sender"[\s\S]{0,160}data-shellx-release-observe="nonempty"/.test(connectorsSource)
    && /id="connector-sim-conversation"[\s\S]{0,160}data-shellx-release-observe="nonempty"/.test(connectorsSource)
    && /id="connector-sim-text"[\s\S]{0,160}data-shellx-release-observe="nonempty"/.test(connectorsSource)
    && /data-debug-id="surface-components-settings-connectorstab-21"[\s\S]{0,180}data-shellx-release-observe="nonempty"/.test(connectorsSource),
  "Connectors exposes every token or identifier draft only through the boolean value-blind projection",
);
assert(
  rightRailSource.includes("data-shellx-tool-exposure={option.mode}")
    && rightRailSource.includes('data-shellx-release-observe="pressed"')
    && appSource.includes("shellxToolExposure: normalizeShellxToolExposure(activeTab.shellxToolExposure)"),
  "per-tab ShellX tool exposure declares a bounded pressed observation and public non-sensitive backing-state receipt",
);
assert(
  gitPaneSource.includes('data-shellx-release-observe="title"')
    && gitPaneSource.includes('data-shellx-release-observe="selected"')
    && gitPaneSource.includes("data-git-diff-scope={scope}"),
  "GitPane declares only bounded refresh-sequence and exact diff-scope selection observations",
);
assert(
  rightRailSource.includes('data-shellx-release-control="model-cards-refresh"')
    && rightRailSource.includes('data-shellx-release-observe="title"'),
  "model instruction cards declare a stable control and bounded refresh-sequence observation",
);
assert(
  rightRailSource.includes('data-release-environment-control="trace"')
    && rightRailSource.includes("environmentRefreshSequence")
    && rightRailSource.includes("release fixture trace export boundary completed")
    && rightRailSource.includes("if (debugSnapshot)"),
  "environment refresh and trace expose bounded renderer-fixture receipts before live CLI or filesystem effects",
);
assert(
  permissionPillSource.includes('data-shellx-release-control={debugFixture ? "permission-decision-receipt" : undefined}')
    && permissionPillSource.includes('data-shellx-release-observe={debugFixture ? "title" : undefined}'),
  "permission fixtures expose only the exact non-secret decision receipt title",
);
assert(
  sessionTabsSource.includes('data-shellx-release-observe="scrollLeft scrollWidth clientWidth"')
    && sessionTabsSource.includes('data-shellx-release-observe="expanded"')
    && sessionTabsSource.includes('data-shellx-release-observe="value"'),
  "Session Tabs declares only bounded rail, dropdown, and rename-draft observations for lifecycle proof",
);
assert(
  tasksPanelSource.includes('data-shellx-release-observe="title"')
    && tasksPanelSource.includes('data-shellx-release-observe="value"')
    && tasksPanelSource.includes('data-shellx-release-observe="expanded"')
    && tasksPanelSource.includes("data-task-id={task.taskId}"),
  "TasksPanel declares only bounded refresh, filter, and disclosure observations scoped by exact task identity",
);
assert(
  chatOutputSource.includes("tabIndex={0}")
    && (chatOutputSource.match(/data-shellx-release-observe="expanded"/g) ?? []).length === 1,
  "ChatOutput exposes a focusable native scroll owner and only its reachable boolean disclosure observation",
);
assert(
  previewCenterSource.includes('data-shellx-release-observe="title"')
    && filePreviewSource.includes('data-shellx-release-observe="title"')
    && filePreviewSource.includes("File preview ready"),
  "Preview Center exposes bounded non-sensitive path and file-read receipt titles",
);
assert(
  bottomPanelSource.includes('data-shellx-release-observe="mounted"')
    && bottomPanelSource.includes("data-shellx-release-mounted={terminalEverShown ?")
    && bottomPanelSource.includes('data-shellx-release-observe="value"')
    && !bottomPanelSource.includes('data-shellx-release-observe="pressed"'),
  "BottomPanel exposes only bounded terminal-mount and composer-value observations",
);
assert(
  buildRunCockpitSource.includes('data-shellx-release-control="build-run-state-receipt"')
    && buildRunCockpitSource.includes('data-shellx-release-observe="title"'),
  "Build Run Cockpit declares one bounded finite-state receipt without exposing objective or scratchboard text",
);
assert(
  installedInputSource.includes("observeReleaseSurfaceInstalledInputElement") &&
    installedInputSource.includes("refuses arbitrary renderer script execution"),
  "installed input exposes bounded observations while arbitrary macOS renderer scripts remain forbidden",
);
assert(overlaySource.includes("measuredHighlightsKey"), "overlay tags measured results with the active highlight request key");
assert(overlaySource.includes("if (measuredHighlightsKey !== highlightsKey) return"), "overlay does not publish stale highlight measurements");
assert(overlaySource.includes("visibleViewportRect"), "overlay clips highlight borders to the visible viewport");
assert(
  overlaySource.includes("const VIEWPORT_EDGE = 0") &&
    overlaySource.includes("Math.max(rect.left, VIEWPORT_EDGE)") &&
    overlaySource.includes("window.innerHeight - VIEWPORT_EDGE"),
  "overlay measures clipping against the actual viewport edge instead of label padding",
);
assert(overlaySource.includes("visibleRect"), "overlay reports the visible highlight rectangle");
assert(overlaySource.includes("clipped"), "overlay reports when highlights are clipped");
assert(cssSource.includes(".debug-highlight-overlay-root"), "overlay has dedicated CSS");
assert(bottomPanelSource.includes('data-debug-id="composer-send"'), "composer send button has a stable debug target id");
assert(
  /className=\{`composer-attachment-chip[\s\S]{0,240}data-shellx-release-observe="title"/.test(bottomPanelSource),
  "composer attachment chips explicitly allow only their bounded title for release proof",
);
assert(
  settingsSource.includes('data-shellx-release-observe="selected"')
    && generalSettingsSource.includes('data-debug-id="settings-browser-download-folder"')
    && generalSettingsSource.includes('data-shellx-release-observe="value"')
    && downloadSidecarSource.includes('data-debug-id="shellx-browser-download-folder"')
    && downloadSidecarSource.includes('data-shellx-release-observe="value"')
    && attachmentBoardSource.includes('data-debug-id="surface-components-attachmentmediaboard-9"')
    && attachmentBoardSource.includes('data-shellx-release-observe="title"'),
  "native picker lifecycle exposes only bounded selected, value, and title observations",
);
assert(
  /data-hunk-idx=\{i\}[\s\S]{0,120}data-shellx-release-observe="focused"/.test(chatOutputSource),
  "diff hunks explicitly allow only their bounded focus state for release proof",
);
assert(
  /aria-label=\{`hunk \$\{i \+ 1\} of \$\{hunks\.length\}`\}[\s\S]{0,120}onMouseDown=\{\(event\) => event\.currentTarget\.focus\(\)\}/.test(chatOutputSource),
  "pointer activation must explicitly focus a diff hunk before native j/k/y/n keyboard handling",
);
assert(
  bottomPanelSource.includes('debugId="composer-voice-chat"') && micButtonSource.includes("data-debug-id={debugId}"),
  "voice chat button has a stable debug target id",
);
assert(
  bottomPanelSource.includes("releaseTestVoiceRecording={releaseTestVoiceRecording}")
    && bottomPanelSource.includes("releaseTestRecording={releaseTestVoiceRecording}")
    && bottomPanelSource.includes("voiceChatRef.current?.cancel()")
    && micButtonSource.includes('if (releaseTestRecording) setState("recording")')
    && micButtonSource.includes('if (releaseTestRecording) setState("idle")')
    && micButtonSource.includes('setState("idle")'),
  "isolated voice fixture reaches the real MicButton cancel and stop state machine plus voice-off control",
);
assert(
  appSource.includes('releaseTestBoundary={releaseTestExternalEffectBoundary === "artifact-archive"}')
    && appSource.includes("release fixture artifact archive stopped before save picker")
    && appSource.includes('data-shellx-release-observe="title"')
    && appSource.indexOf("if (releaseTestBoundary)") < appSource.indexOf("const target = await saveDialog"),
  "artifact archive fixture exposes a bounded title receipt before the operating-system save picker",
);
assert(
  prCreateSource.includes('releaseTestBoundary: "stop-before-remote"')
    && prCreateSource.includes("release fixture PR create stopped before remote mutation")
    && prCreateSource.includes('data-release-pr-create-receipt="boundary"')
    && prCreateSource.includes('data-shellx-release-observe="disabled"'),
  "PR create fixture exposes bounded readiness and the exact isolated pre-remote receipt",
);
assert(debugApiSource.includes("debugHighlights"), "debug API accepts debugHighlights UI patches");
assert(debugApiSource.includes("debugHighlightResults"), "debug API stores highlight resolution results");
assert(
  debugApiSource.includes("pub title: Option<String>")
    && debugApiSource.includes("pub enum DebugElementObservationField")
    && debugApiSource.includes("if let Some(title) = observation.title.as_mut()"),
  "Rust debug API preserves and bounds declared title observations",
);
assert(apiDocs.includes("debugHighlights?"), "API docs document debugHighlights");
assert(apiDocs.includes("visibleRect?"), "API docs document visible highlight rectangles");
assert(apiDocs.includes("clipped?"), "API docs document clipped highlight results");
assert(apiDocs.includes("data-shellx-release-observe"), "API docs document the fail-closed observation declaration");
assert(apiDocs.includes('data-shellx-release-observe="href"'), "API docs document the HTTPS-only anchor observation");
assert(
  apiDocs.includes('data-shellx-release-mounted="true|false"'),
  "API docs document the boolean-only mounted observation projection",
);
assert(
  apiDocs.includes("`nonempty`") && apiDocs.includes("without returning their bytes"),
  "API docs document the value-blind nonempty observation projection",
);
assert(apiDocs.includes("activeTab.shellxToolExposure"), "API docs document the non-secret per-tab ShellX tool-exposure receipt");
assert(
  apiDocs.includes('releaseTestExternalEffectBoundary: "pr-create" | "artifact-archive" | "clear"')
    && apiDocs.includes('releaseTestBoundary?: "stop-before-remote"'),
  "API docs document both isolated external-effect boundary commands",
);
assert(surfaceSweep.includes("debugHighlights"), "debug UI surface sweep captures highlight overlay");
assert(surfaceSweep.includes("debugHighlightResultsBySurface?.app"), "debug UI surface sweep reads app-scoped highlight results");
assert(surfaceSweep.includes('text: "New session tab"'), "debug UI surface sweep targets the current new-session palette action");
assert(surfaceSweep.includes("waitForFreshOpenTab") && surfaceSweep.includes("openTabs"), "debug UI surface sweep waits for a new open tab before focusing it");
assert(surfaceSweep.includes("existingTabIds.length > 0"), "debug UI surface sweep reuses an existing tab before creating one");
assert(surfaceSweep.includes("SHELLX_DEBUG_SCREENSHOT_FULL"), "debug UI surface sweep can opt into full-screen screenshot fallback");
assert(surfaceSweep.includes("SHELLX_DEBUG_SELECTOR_TIMEOUT_MS"), "debug UI surface sweep has a configurable selector wait budget");
assert(surfaceSweep.includes("focusMainShellxWindow") && surfaceSweep.includes("/vault/open-panel"), "debug UI surface sweep foregrounds ShellX before app-surface driving");
assert(
  surfaceSweep.includes('debugSurface: "app"') &&
    surfaceSweep.includes("lastBroadcastMs") &&
    surfaceSweep.includes("broadcastAttempt"),
  "debug UI surface sweep retries app-scoped highlight requests after renderer revision races",
);

if (failures > 0) {
  console.error(`\n${failures} debug highlight check(s) failed.`);
  process.exit(1);
}

console.log("debug highlight overlay checks passed");
