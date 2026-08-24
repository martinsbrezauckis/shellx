/**
 * Exact, non-mutating ShellX surfaces which a public manual link may reveal.
 *
 * This is intentionally a small allow-list rather than a generic navigation
 * API. A feature is enabled only when its destination is an existing typed UI
 * state and its focus target is a stable `data-debug-id`. Browser navigation,
 * tasks, Vault records/requests, provider calls, and every action control are
 * deliberately absent.
 */
import type { BottomTab, RightTab } from "./ui-navigation";
import type { SettingsTab } from "./settings";

export type ManualMainIntent =
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "rightRail"; tab: RightTab }
  | { kind: "bottomPanel"; tab: BottomTab }
  | { kind: "modal"; modal: "palette" | "plugins" | "connectorInbox" | "taskManager" }
  | { kind: "find" };

export interface ManualMainSurface {
  readonly featureId: string;
  readonly intent: ManualMainIntent;
  /** Exact, source-owned element marker.  Never a CSS path or user input. */
  readonly focusId: string;
}

const surfaces: readonly ManualMainSurface[] = [
  { featureId: "shellx.interface.header.about", intent: { kind: "settings", tab: "about" }, focusId: "settings-tab-about" },
  { featureId: "shellx.interface.header.find", intent: { kind: "find" }, focusId: "find-sessions-input" },
  { featureId: "shellx.interface.header.inbox", intent: { kind: "modal", modal: "connectorInbox" }, focusId: "connector-inbox-modal" },
  { featureId: "shellx.interface.header.plugins", intent: { kind: "modal", modal: "plugins" }, focusId: "plugins-modal" },
  { featureId: "shellx.interface.header.settings", intent: { kind: "settings", tab: "general" }, focusId: "settings-tab-general" },
  { featureId: "shellx.tasks.manager", intent: { kind: "modal", modal: "taskManager" }, focusId: "task-manager" },
  { featureId: "shellx.interface.right.tasks", intent: { kind: "rightRail", tab: "Tasks" }, focusId: "right-tab-tasks" },
  { featureId: "shellx.interface.right.tools", intent: { kind: "rightRail", tab: "Tooling" }, focusId: "right-tab-tooling" },
  { featureId: "shellx.interface.right.git", intent: { kind: "rightRail", tab: "Git" }, focusId: "right-tab-git" },
  { featureId: "shellx.interface.right.preview", intent: { kind: "rightRail", tab: "Preview" }, focusId: "right-tab-preview" },
  { featureId: "shellx.interface.right.plan", intent: { kind: "rightRail", tab: "Plan" }, focusId: "right-tab-plan" },
  { featureId: "shellx.interface.right.files", intent: { kind: "rightRail", tab: "Files" }, focusId: "right-tab-files" },
  { featureId: "shellx.interface.bottom.chat", intent: { kind: "bottomPanel", tab: "Chat" }, focusId: "bottom-tab-chat" },
  { featureId: "shellx.interface.bottom.terminal", intent: { kind: "bottomPanel", tab: "Terminal" }, focusId: "bottom-tab-terminal" },
  { featureId: "shellx.interface.bottom.images", intent: { kind: "bottomPanel", tab: "Images" }, focusId: "bottom-tab-images" },
  { featureId: "shellx.interface.bottom.videos", intent: { kind: "bottomPanel", tab: "Videos" }, focusId: "bottom-tab-videos" },
  { featureId: "shellx.interface.bottom.logs", intent: { kind: "bottomPanel", tab: "Logs" }, focusId: "bottom-tab-logs" },
  { featureId: "shellx.interface.bottom.stderr", intent: { kind: "bottomPanel", tab: "Stderr" }, focusId: "bottom-tab-stderr" },
  { featureId: "shellx.interface.command.settings", intent: { kind: "settings", tab: "general" }, focusId: "settings-tab-general" },
  { featureId: "shellx.interface.command.desktop", intent: { kind: "settings", tab: "desktop" }, focusId: "settings-tab-desktop" },
  { featureId: "shellx.interface.command.toggle_terminal", intent: { kind: "bottomPanel", tab: "Terminal" }, focusId: "bottom-tab-terminal" },
  { featureId: "shellx.interface.settings.general", intent: { kind: "settings", tab: "general" }, focusId: "settings-tab-general" },
  { featureId: "shellx.interface.settings.vault", intent: { kind: "settings", tab: "vault" }, focusId: "settings-tab-vault" },
  { featureId: "shellx.interface.settings.connections", intent: { kind: "settings", tab: "connections" }, focusId: "settings-tab-connections" },
  { featureId: "shellx.interface.settings.connectors", intent: { kind: "settings", tab: "connectors" }, focusId: "settings-tab-connectors" },
  { featureId: "shellx.interface.settings.desktop", intent: { kind: "settings", tab: "desktop" }, focusId: "settings-tab-desktop" },
  { featureId: "shellx.interface.settings.shellxagent", intent: { kind: "settings", tab: "shellxagent" }, focusId: "settings-tab-shellxagent" },
  { featureId: "shellx.interface.settings.data", intent: { kind: "settings", tab: "data" }, focusId: "settings-tab-data" },
  { featureId: "shellx.interface.settings.about", intent: { kind: "settings", tab: "about" }, focusId: "settings-tab-about" },
];

export const MANUAL_MAIN_SURFACE_BY_FEATURE_ID: ReadonlyMap<string, ManualMainSurface> = new Map(
  surfaces.map((surface) => [surface.featureId, surface]),
);

export function resolveManualMainSurface(featureId: unknown): ManualMainSurface | null {
  if (typeof featureId !== "string") return null;
  return MANUAL_MAIN_SURFACE_BY_FEATURE_ID.get(featureId) ?? null;
}

/** Focus only an exact, renderer-owned marker; never synthesize a click. */
export async function focusManualSurfaceDebugId(focusId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(focusId)) return false;
  // A modal/tab may need one React commit before the visible control exists.
  // Bound the wait so a stale mapping cannot create a background retry loop.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const target = document.querySelector<HTMLElement>(
      `[data-debug-id="${focusId}"], [data-manual-focus-id="${focusId}"]`,
    );
    if (!target) continue;
    target.focus({ preventScroll: false });
    return document.activeElement === target;
  }
  return false;
}
