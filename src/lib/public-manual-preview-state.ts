import type { SettingsTab } from "./settings";
import type { RightTab } from "./ui-navigation";

type TaskManagerDetail = "schedule" | "providers" | null;

export interface PublicManualPreviewStateActions {
  openCommandPalette(): void;
  openRequests(): void;
  openPlugins(): void;
  openInbox(): void;
  openRightRail(tab: RightTab): void;
  openBottomTab(tab: "Terminal" | "Logs" | "Stderr"): void;
  openActivity(): void;
  openAssetBoard(): void;
  openSettings(tab: SettingsTab): void;
  openTaskManager(detail: TaskManagerDetail): void;
}

const RIGHT_RAIL_TAB_BY_STATE: Readonly<Record<string, RightTab>> = {
  "right-rail-tasks": "Tasks",
  "right-rail-tools": "Tooling",
  "right-rail-git": "Git",
  "right-rail-preview": "Preview",
  "right-rail-plan": "Plan",
  "right-rail-files": "Files",
};

const SETTINGS_TABS = new Set<SettingsTab>([
  "general",
  "vault",
  "connections",
  "connectors",
  "desktop",
  "shellxagent",
  "data",
  "about",
]);

/**
 * Apply the manual iframe's selected feature state without transferring focus
 * into the iframe. The parent manual owns initial and search-result focus;
 * this only opens the corresponding desktop surface for the preview.
 */
export function applyPublicManualPreviewState(
  stateId: string,
  actions: PublicManualPreviewStateActions,
): void {
  if (stateId === "command-palette") {
    actions.openCommandPalette();
    return;
  }
  if (stateId === "header-requests") {
    actions.openRequests();
    return;
  }
  if (stateId === "header-plugins") {
    actions.openPlugins();
    return;
  }
  if (stateId === "header-inbox") {
    actions.openInbox();
    return;
  }

  const rightRailTab = RIGHT_RAIL_TAB_BY_STATE[stateId];
  if (rightRailTab) {
    actions.openRightRail(rightRailTab);
    return;
  }
  if (stateId === "bottom-terminal") {
    actions.openBottomTab("Terminal");
    return;
  }
  if (stateId === "bottom-trace") {
    actions.openActivity();
    return;
  }
  if (stateId === "bottom-assets") {
    actions.openAssetBoard();
    return;
  }
  if (stateId === "bottom-logs") {
    actions.openBottomTab("Logs");
    return;
  }
  if (stateId === "bottom-stderr") {
    actions.openBottomTab("Stderr");
    return;
  }

  if (stateId.startsWith("settings-")) {
    const settingsTab = stateId.slice("settings-".length) as SettingsTab;
    if (SETTINGS_TABS.has(settingsTab)) actions.openSettings(settingsTab);
    return;
  }
  if (stateId.startsWith("task-manager-")) {
    actions.openTaskManager(
      stateId === "task-manager-schedule"
        ? "schedule"
        : stateId === "task-manager-providers"
          ? "providers"
          : null,
    );
  }
}
