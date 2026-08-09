import { readSettingsLocal, persistSettings, type SettingsValues } from "../lib/settings";
import type { BrowserColorMode } from "./components/BrowserMenus";

export const DEFAULT_HOME_URL = "https://example.com/";
export const COLOR_MODE_STORAGE_KEY = "shellx-browser-color-mode";
export const HOME_URL_STORAGE_KEY = "shellx-browser-home-url";
export const DOWNLOAD_FOLDER_STORAGE_KEY = "shellx-browser-download-folder";

export function initialColorMode(): BrowserColorMode {
  const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

export function initialHomeUrl(): string {
  const stored = window.localStorage.getItem(HOME_URL_STORAGE_KEY)?.trim();
  return stored || DEFAULT_HOME_URL;
}

export function persistBrowserColorMode(value: BrowserColorMode): void {
  if (value === "system") window.localStorage.removeItem(COLOR_MODE_STORAGE_KEY);
  else window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, value);
}

export function persistBrowserHomeUrl(value: string): string {
  const normalized = value.trim() || DEFAULT_HOME_URL;
  if (normalized === DEFAULT_HOME_URL) window.localStorage.removeItem(HOME_URL_STORAGE_KEY);
  else window.localStorage.setItem(HOME_URL_STORAGE_KEY, normalized);
  return normalized;
}

export function initialDownloadFolder(): string {
  const settings = readSettingsLocal();
  const legacy = window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY)?.trim() ?? "";
  return settings.browserDownloadFolder.trim() || legacy;
}

export function persistBrowserDownloadFolder(value: string): SettingsValues {
  const next = { ...readSettingsLocal(), browserDownloadFolder: value.trim() };
  persistSettings(next);
  window.localStorage.removeItem(DOWNLOAD_FOLDER_STORAGE_KEY);
  return next;
}
