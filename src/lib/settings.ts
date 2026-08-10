import { apiPost } from "./debug-api";

export type DensityMode = "compact" | "default" | "comfortable";
export type ThemeMode = "black" | "black_warm" | "bright";
export type SettingsTab = "general" | "vault" | "connections" | "connectors" | "desktop" | "shellxagent" | "data" | "about";

export interface SettingsValues {
  density: DensityMode;
  theme: ThemeMode;
  chatFontPx: number;
  browserDownloadFolder: string;
}

export const FONT_PX_MIN = 12;
export const FONT_PX_MAX = 26;
export const FONT_PX_DEFAULT = 19;
export const TAB_KEY = "shellX.settingsTab.v2";
export const ALL_SETTINGS_TABS: readonly SettingsTab[] = [
  "general",
  "vault",
  "connections",
  "connectors",
  "desktop",
  "shellxagent",
  "data",
  "about",
];

export const DEFAULT_SETTINGS: SettingsValues = {
  density: "default",
  theme: "black",
  chatFontPx: FONT_PX_DEFAULT,
  browserDownloadFolder: "",
};

const STORAGE_KEY = "shellX.settings.v2";
const LEGACY_STORAGE_KEY = "grok-shell.settings.v1";
const LEGACY_TAB_KEY = "grok-shell.settingsTab.v1";

function readMigratedLocalStorage(key: string, legacyKeys: readonly string[]): string | null {
  try {
    const canonical = localStorage.getItem(key);
    if (canonical !== null) {
      for (const legacyKey of legacyKeys) localStorage.removeItem(legacyKey);
      return canonical;
    }
  } catch { /* localStorage may be unavailable */ }
  for (const legacyKey of legacyKeys) {
    try {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(legacyKey);
        return legacy;
      }
    } catch { /* localStorage may be unavailable */ }
  }
  return null;
}

function writeMigratedLocalStorage(key: string, value: string, legacyKeys: readonly string[]): void {
  try {
    localStorage.setItem(key, value);
    for (const legacyKey of legacyKeys) localStorage.removeItem(legacyKey);
  } catch { /* localStorage may be unavailable */ }
}

function readObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

export function normalizeSettings(raw: unknown): SettingsValues {
  const densityValue = readObjectProperty(raw, "density");
  const themeValue = readObjectProperty(raw, "theme");
  const chatFontPxValue = readObjectProperty(raw, "chatFontPx");
  const browserDownloadFolderValue = readObjectProperty(raw, "browserDownloadFolder");
  const density: DensityMode =
    densityValue === "compact" || densityValue === "comfortable" || densityValue === "default"
      ? densityValue
      : DEFAULT_SETTINGS.density;
  const theme: ThemeMode =
    themeValue === "black_warm" || themeValue === "black" || themeValue === "bright"
      ? themeValue
      : DEFAULT_SETTINGS.theme;
  const chatFontPx =
    typeof chatFontPxValue === "number" && Number.isFinite(chatFontPxValue)
      ? Math.max(FONT_PX_MIN, Math.min(FONT_PX_MAX, Math.round(chatFontPxValue)))
      : DEFAULT_SETTINGS.chatFontPx;
  const browserDownloadFolder =
    typeof browserDownloadFolderValue === "string" ? browserDownloadFolderValue.trim() : "";
  return { density, theme, chatFontPx, browserDownloadFolder };
}

export function readSettingsLocal(): SettingsValues {
  try {
    const raw = readMigratedLocalStorage(STORAGE_KEY, [LEGACY_STORAGE_KEY]);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch { /* fall back to defaults */ }
  return { ...DEFAULT_SETTINGS };
}

export function persistSettings(settings: SettingsValues): void {
  const normalized = normalizeSettings(settings);
  writeMigratedLocalStorage(STORAGE_KEY, JSON.stringify(normalized), [LEGACY_STORAGE_KEY]);
  void apiPost("/settings", normalized).catch(() => { /* debug API may be off */ });
}

export function readSettingsTab(): SettingsTab {
  const raw = readMigratedLocalStorage(TAB_KEY, [LEGACY_TAB_KEY]);
  return ALL_SETTINGS_TABS.find((tab) => tab === raw) ?? "general";
}

export function persistSettingsTab(tab: SettingsTab): void {
  writeMigratedLocalStorage(TAB_KEY, tab, [LEGACY_TAB_KEY]);
}

export function applyTheme(
  settings: Pick<SettingsValues, "density" | "theme" | "chatFontPx">,
): void {
  const root = document.documentElement;
  root.setAttribute("data-density", settings.density);
  root.setAttribute("data-theme", settings.theme);
  const px = Math.max(FONT_PX_MIN, Math.min(FONT_PX_MAX, settings.chatFontPx || FONT_PX_DEFAULT));
  root.style.setProperty("--fs-body", `${px}px`);
  root.style.setProperty("--fs-body-md", `${Math.max(13, px - 2)}px`);
  const monoPx = Math.max(11, px - 1);
  root.style.setProperty("--fs-mono", `${monoPx}px`);
  try {
    window.dispatchEvent(new CustomEvent("shellx-font-change", {
      detail: { bodyPx: px, monoPx },
    }));
  } catch { /* SSR or no CustomEvent */ }
}
