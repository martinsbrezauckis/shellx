/**
 * Canonical high-level ShellX navigation registries.
 *
 * The renderer, Debug API patch normalizers, documentation tests, and the
 * bounded state-space walker all consume these lists. Keeping the wire values
 * in one module prevents a tab/modal from being rendered but unreachable (or
 * accepted by automation but absent from the UI).
 */
export const RIGHT_RAIL_TABS = ["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"] as const;
export type RightTab = typeof RIGHT_RAIL_TABS[number];

export const BOTTOM_PANEL_TABS = ["Chat", "Terminal", "Images", "Videos", "Logs", "Stderr"] as const;
export type BottomTab = typeof BOTTOM_PANEL_TABS[number];

export const COMPOSER_DEBUG_MENUS = ["connection", "agent", "branch", "slash", "close"] as const;
export type ComposerDebugMenu = typeof COMPOSER_DEBUG_MENUS[number];

export const DEBUG_MODAL_IDS = [
  "activity",
  "assets",
  "buildPlanReview",
  "close",
  "connectorInbox",
  "help",
  "palette",
  "plugins",
  "preview",
  "pr",
  "settings",
  "vault",
  "workPreview",
] as const;
export type DebugModalId = typeof DEBUG_MODAL_IDS[number];

const RIGHT_TAB_BY_WIRE = wireMap(RIGHT_RAIL_TABS);
const BOTTOM_TAB_BY_WIRE = wireMap(BOTTOM_PANEL_TABS);
const COMPOSER_MENU_SET = new Set<string>(COMPOSER_DEBUG_MENUS);
const DEBUG_MODAL_SET = new Set<string>(DEBUG_MODAL_IDS);

export function isRightTab(value: unknown): value is RightTab {
  return typeof value === "string" && RIGHT_TAB_BY_WIRE.get(value.toLowerCase()) === value;
}

export function isBottomTab(value: unknown): value is BottomTab {
  return typeof value === "string" && BOTTOM_TAB_BY_WIRE.get(value.toLowerCase()) === value;
}

export function normalizeRightTabPatch(value: unknown): RightTab | null {
  if (isRightTab(value)) return value;
  if (typeof value !== "string") return null;
  return RIGHT_TAB_BY_WIRE.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeBottomTabPatch(value: unknown): BottomTab | null {
  if (isBottomTab(value)) return value;
  if (typeof value !== "string") return null;
  return BOTTOM_TAB_BY_WIRE.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeComposerDebugMenu(value: unknown): ComposerDebugMenu | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return COMPOSER_MENU_SET.has(key) ? key as ComposerDebugMenu : null;
}

export function normalizeDebugModal(value: unknown): DebugModalId | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return DEBUG_MODAL_SET.has(key) ? key as DebugModalId : null;
}

function wireMap<T extends string>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.toLowerCase(), value]));
}
