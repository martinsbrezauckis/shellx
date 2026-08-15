export type ManualAtlasCaptureSurface = "app" | "browser";

export type ManualAtlasCaptureStep =
  | { kind: "patch"; surface: ManualAtlasCaptureSurface; body: Record<string, unknown> }
  | { kind: "click"; selector: string }
  | { kind: "wait"; selector: string }
  | { kind: "reveal"; selector: string; block: "start" | "center" | "end" }
  | { kind: "scroll"; selector: string; edge: "top" | "bottom" };

export interface ManualAtlasCapturePlanEntry {
  id: string;
  surface: ManualAtlasCaptureSurface;
  intendedState: string;
  steps: readonly ManualAtlasCaptureStep[];
}

const appPatch = (body: Record<string, unknown>): ManualAtlasCaptureStep => ({
  kind: "patch",
  surface: "app",
  body: { debugSurface: "app", source: "manual-atlas-installed-candidate", ...body },
});

const browserClick = (selector: string): ManualAtlasCaptureStep => ({
  kind: "click",
  selector,
});

const wait = (selector: string): ManualAtlasCaptureStep => ({ kind: "wait", selector });

const appBaseline = {
  openModal: "close",
  bottomTab: "Chat",
  rightTab: "Tasks",
  vaultRequestCenterOpen: false,
  setupGuideDismissed: true,
  debugHighlights: [],
};

const rightRailStates = [
  ["right-rail-tasks", "Tasks"],
  ["right-rail-tools", "Tooling"],
  ["right-rail-git", "Git"],
  ["right-rail-preview", "Preview"],
  ["right-rail-plan", "Plan"],
  ["right-rail-files", "Files"],
] as const;

const settingsStates = [
  ["settings-general", "general", "General"],
  ["settings-vault", "vault", "Vault"],
  ["settings-connections", "connections", "Connections"],
  ["settings-connectors", "connectors", "Connectors"],
  ["settings-desktop", "desktop", "Desktop"],
  ["settings-shellxagent", "shellxagent", "shellXagent"],
  ["settings-data", "data", "Data"],
  ["settings-about", "about", "About"],
] as const;

const browserPanelStates = [
  ["browser-panel-chat", "chat", "Chat"],
  ["browser-panel-requests", "requests", "Requests"],
  ["browser-panel-actions", "actions", "Actions"],
  ["browser-panel-evidence", "evidence", "Evidence"],
  ["browser-panel-errors", "errors", "Errors"],
] as const;

const appCaptures: ManualAtlasCapturePlanEntry[] = [
  {
    id: "shellx-workspace",
    surface: "app",
    intendedState: "Installed ShellX workspace with the setup guide dismissed, Chat and Tasks selected, and no modal or request popover open.",
    steps: [appPatch(appBaseline), wait(".shell")],
  },
  {
    id: "command-palette",
    surface: "app",
    intendedState: "Installed ShellX command palette open over the normal workspace with its complete available action list visible.",
    steps: [appPatch({ ...appBaseline, openModal: "palette" }), wait("[role='dialog'][aria-label='Command palette']")],
  },
  {
    id: "header-requests",
    surface: "app",
    intendedState: "Installed ShellX Vault Request Center open from the header while the rest of the workspace remains in its normal baseline state.",
    steps: [appPatch({ ...appBaseline, vaultRequestCenterOpen: true }), wait("[data-debug-id='vault-request-center-popover']")],
  },
  {
    id: "header-plugins",
    surface: "app",
    intendedState: "Installed ShellX Plugins dialog open with the Vault Request Center closed and the workspace visible behind it.",
    steps: [appPatch({ ...appBaseline, openModal: "plugins" }), wait("[role='dialog'][aria-label='Plugins']")],
  },
  ...rightRailStates.map(([id, tab]) => ({
    id,
    surface: "app" as const,
    intendedState: `Installed ShellX workspace with the ${tab} right-rail tab selected and its distinct panel visible.`,
    steps: [appPatch({ ...appBaseline, rightTab: tab }), wait(`[data-debug-id='right-tab-${tab.toLowerCase()}'][aria-selected='true']`)],
  })),
  {
    id: "bottom-terminal",
    surface: "app",
    intendedState: "Installed ShellX workspace with the persistent Terminal bottom panel selected and visible.",
    steps: [appPatch({ ...appBaseline, bottomTab: "Terminal" }), wait("[data-debug-id='bottom-tab-terminal'].active")],
  },
  {
    id: "bottom-trace",
    surface: "app",
    intendedState: "Installed ShellX Activity Browser opened from Trace with its Files view and navigation visible.",
    steps: [appPatch({ ...appBaseline, openModal: "activity" }), wait("[role='dialog'][aria-label='Activity Browser']")],
  },
  {
    id: "bottom-assets",
    surface: "app",
    intendedState: "Installed ShellX attachment and media board opened from Assets without any private user files in the disposable profile.",
    steps: [appPatch({ ...appBaseline, openModal: "assets" }), wait("[role='dialog'][aria-label='Attachment and media board']")],
  },
  {
    id: "bottom-logs",
    surface: "app",
    intendedState: "Installed ShellX workspace with the raw event Logs bottom panel selected and visible.",
    steps: [appPatch({ ...appBaseline, bottomTab: "Logs" }), wait("[data-debug-id='bottom-tab-logs'].active")],
  },
  {
    id: "bottom-stderr",
    surface: "app",
    intendedState: "Installed ShellX workspace with the Stderr bottom panel selected and visible.",
    steps: [appPatch({ ...appBaseline, bottomTab: "Stderr" }), wait("[data-debug-id='bottom-tab-stderr'].active")],
  },
  ...settingsStates.map(([id, tab, label]) => ({
    id,
    surface: "app" as const,
    intendedState: `Installed ShellX Settings dialog with the ${label} tab selected and its distinct settings surface visible.`,
    steps: [
      appPatch({ ...appBaseline, openModal: "settings" }),
      appPatch({ debugClick: { selector: `[data-debug-id='settings-tab-${tab}']` } }),
      wait(`[data-debug-id='settings-tab-${tab}'][aria-selected='true']`),
    ],
  })),
  {
    id: "task-manager-overview",
    surface: "app",
    intendedState: "Installed ShellX Task Manager showing one reviewed task definition, attention state, schedule, environment, agent route, and durable actions.",
    steps: [appPatch({ ...appBaseline, debugTaskManagerFixture: "full" }), wait("[data-debug-id='task-manager']")],
  },
  {
    id: "task-manager-schedule",
    surface: "app",
    intendedState: "Installed ShellX Task Manager with its local-time schedule and Advanced timing and notifications disclosure opened for review.",
    steps: [
      appPatch({ ...appBaseline, debugTaskManagerFixture: "full" }),
      { kind: "click", selector: "[data-debug-id='task-manager-schedule-advanced']" },
      { kind: "reveal", selector: "[data-debug-id='task-manager-schedule-advanced']", block: "center" },
      wait("[data-debug-id='task-manager-max-run-seconds']"),
    ],
  },
  {
    id: "task-manager-providers",
    surface: "app",
    intendedState: "Installed ShellX Task Manager showing the selected environment, fresh availability, and explicit ordered agent fallback route.",
    steps: [
      appPatch({ ...appBaseline, debugTaskManagerFixture: "full" }),
      { kind: "reveal", selector: "[data-debug-id='task-manager-provider-list']", block: "center" },
      wait("[data-debug-id='task-manager-provider-list']"),
    ],
  },
  {
    id: "task-manager-evidence",
    surface: "app",
    intendedState: "Installed ShellX Task Manager showing receipt-backed pending, running, completed, unknown-outcome, and missed-run history states.",
    steps: [
      appPatch({ ...appBaseline, debugTaskManagerFixture: "full" }),
      { kind: "reveal", selector: ".task-manager-history", block: "start" },
      wait("[data-debug-id='task-manager-run-run-fixture-completed']"),
    ],
  },
];

const browserCaptures: ManualAtlasCapturePlanEntry[] = [
  {
    id: "browser-overview",
    surface: "browser",
    intendedState: "Installed ShellX Browser window showing its tab strip, navigation chrome, page viewport, and Chat right sidebar in the disposable profile.",
    steps: [browserClick("[data-debug-id='shellx-browser-right-tab-chat']"), wait(".shellx-browser-app")],
  },
  {
    id: "browser-options",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the complete Browser options sidecar open.",
    steps: [browserClick("[data-debug-id='shellx-browser-options']"), wait("[data-debug-id='shellx-browser-options-sidecar']")],
  },
  {
    id: "browser-save-menu",
    surface: "browser",
    intendedState: "Installed ShellX Browser Save page menu showing its local artifact actions from the top of the menu.",
    steps: [
      browserClick("[data-debug-id='shellx-browser-options-close']"),
      browserClick("[data-debug-id='shellx-browser-save-page']"),
      wait("#shellx-browser-save-menu"),
      { kind: "scroll", selector: "#shellx-browser-save-menu", edge: "top" },
    ],
  },
  {
    id: "browser-save-copy-jobs",
    surface: "browser",
    intendedState: "Installed ShellX Browser Save page menu scrolled to expose every queued media, code, and site copy action.",
    steps: [{ kind: "scroll", selector: "#shellx-browser-save-menu", edge: "bottom" }, wait("[data-debug-id='shellx-browser-save-site']")],
  },
  {
    id: "browser-ads-menu",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the profile ad-filter mode menu open.",
    steps: [browserClick("[data-debug-id='shellx-browser-ad-filter']"), wait("#shellx-browser-ad-filter-menu")],
  },
  {
    id: "browser-history",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the History sidecar open in the disposable profile.",
    steps: [browserClick("[data-debug-id='shellx-browser-history-menu']"), wait("[data-debug-id='shellx-browser-history-sidecar']")],
  },
  {
    id: "browser-bookmarks",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the Bookmarks sidecar open in list mode.",
    steps: [browserClick("[data-debug-id='shellx-browser-bookmarks-menu']"), wait("[data-debug-id='shellx-browser-bookmark-list']")],
  },
  {
    id: "browser-bookmark-manager",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the Bookmark manager Edit surface open.",
    steps: [browserClick("[data-debug-id='shellx-browser-bookmark-manager-toggle']"), wait("[data-debug-id='shellx-browser-bookmark-manager']")],
  },
  {
    id: "browser-downloads",
    surface: "browser",
    intendedState: "Installed ShellX Browser with the Downloads sidecar and download-folder controls visible.",
    steps: [browserClick("[data-debug-id='shellx-browser-downloads-menu']"), wait("[data-debug-id='shellx-browser-download-sidecar']")],
  },
  ...browserPanelStates.map(([id, tab, label], index) => ({
    id,
    surface: "browser" as const,
    intendedState: `Installed ShellX Browser with the ${label} right-sidebar tab selected and its distinct panel visible.`,
    steps: [
      ...(index === 0 ? [browserClick("[data-debug-id='shellx-browser-downloads-close']")] : []),
      browserClick(`[data-debug-id='shellx-browser-right-tab-${tab}']`),
      wait(`[data-debug-id='shellx-browser-right-tab-${tab}'][aria-selected='true']`),
    ],
  })),
];

export const MANUAL_ATLAS_CAPTURE_PLAN: readonly ManualAtlasCapturePlanEntry[] = [
  ...appCaptures,
  ...browserCaptures,
];
